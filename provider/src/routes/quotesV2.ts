/**
 * POST /api/quotes/v2
 *
 * Issues a signed EIP-712 PaymentQuoteV2 for the Document Insights v1 service
 * against a BudgetRailV2 session. No funds move here.
 *
 * V2 differences from V1:
 *   - Fee split: server computes baseAmount, feeAmount, grossAmount using exact
 *     integer arithmetic (FEE_BPS=50, DENOMINATOR=10_000). Never floats.
 *   - Both provider C and treasury E are included in signed data so the contract
 *     can verify no address substitution occurred.
 *   - EIP-712 domain version is "2" — V1 quotes are structurally incompatible.
 *   - Budget cap check uses grossAmount (base + fee), not base alone.
 *   - Returns explicit base/fee/gross breakdown so caller sees the exact cost.
 *
 * Security properties (same as V1 plus):
 *   - Server computes fee server-side; requester cannot supply their own fee.
 *   - Treasury address in quote is taken from server config (immutable contract value).
 *   - If V2 contract address is not configured, returns 503.
 */

import { type Config } from "../lib/config.js";
import { readSessionV2 } from "../lib/onchain.js";
import {
  computeRequestHash,
  generateRequestId,
  signQuoteV2,
  computeV2Fee,
  formatV2DisplayPrice,
  quoteSignerAddressFromPrivKey,
  type SignedQuoteV2,
} from "../lib/eip712.js";
import { checkRateLimit } from "../lib/ratelimit.js";

const SUPPORTED_SERVICES = new Set(["document-insights-v1"]);

export async function handleQuotesV2(config: Config, req: Request): Promise<Response> {
  // ── V2 guard ─────────────────────────────────────────────────────────────
  if (!config.v2ContractAddress) {
    return err(503, "V2 contract not configured on this server");
  }
  const v2Contract = config.v2ContractAddress as `0x${string}`;

  // ── 0. Parse body ────────────────────────────────────────────────────────
  let body: unknown;
  try { body = await req.json(); }
  catch { return err(400, "Invalid JSON body"); }

  if (typeof body !== "object" || body === null)
    return err(400, "Body must be a JSON object");
  const { sessionId: rawSessionId, service, input } = body as Record<string, unknown>;

  // ── 1. Validate service ──────────────────────────────────────────────────
  if (typeof service !== "string" || !SUPPORTED_SERVICES.has(service))
    return err(400, `Unsupported service. Supported: ${[...SUPPORTED_SERVICES].join(", ")}`);

  // ── 2. Validate input ────────────────────────────────────────────────────
  if (typeof input !== "string") return err(400, "input must be a string");
  const inputBytes = new TextEncoder().encode(input);
  if (inputBytes.length === 0) return err(400, "input must not be empty");
  if (inputBytes.length > config.maxInputBytes)
    return err(400, `input exceeds ${config.maxInputBytes} bytes (${inputBytes.length} received)`);

  // ── 3. Validate sessionId ────────────────────────────────────────────────
  if (typeof rawSessionId !== "string" && typeof rawSessionId !== "number")
    return err(400, "sessionId must be a string or number");
  let sessionId: bigint;
  try {
    sessionId = BigInt(rawSessionId as string);
    if (sessionId <= 0n) throw new Error("non-positive");
  } catch { return err(400, "sessionId must be a positive integer"); }

  // ── 4. Rate limit ────────────────────────────────────────────────────────
  if (!checkRateLimit(`v2:quotes:${sessionId}`, config.rateLimitPerMinute))
    return err(429, "Too many V2 quote requests for this session; retry after 60 seconds");

  // ── 5. Read V2 session from chain ────────────────────────────────────────
  let session;
  try { session = await readSessionV2(config, v2Contract, sessionId); }
  catch { return err(503, "Failed to read V2 session from chain; RPC may be unavailable", true); }
  if (!session) return err(404, `V2 session ${sessionId} not found on chain`);

  // ── 6. Validate session state ────────────────────────────────────────────
  if (session.closed) return err(400, "Session is closed");
  const nowSecs = BigInt(Math.floor(Date.now() / 1000));
  if (nowSecs > session.expiresAt) return err(400, "Session has expired");

  // ── 7. Validate provider and signer match server config ──────────────────
  if (session.provider.toLowerCase() !== config.providerPayoutAddress.toLowerCase())
    return err(400, "Session provider does not match this server's payout address");

  const expectedSigner = quoteSignerAddressFromPrivKey(config.quoteSignerPrivateKey);
  if (session.quoteSigner.toLowerCase() !== expectedSigner.toLowerCase())
    return err(400, "Session quoteSigner does not match this server's signing key");

  // ── 8. Compute exact fee split (server-side, never requester-supplied) ───
  const baseAmount = config.v2PricePerCall;
  const { feeAmount, grossAmount } = computeV2Fee(baseAmount);

  // ── 9. Validate gross fits cap and remaining budget ──────────────────────
  // V2: both cap and budget checks use GROSS amount, not base alone.
  if (grossAmount > session.perPaymentCap)
    return err(400,
      `Gross payment (${grossAmount}) exceeds session perPaymentCap (${session.perPaymentCap}). ` +
      `Your session cap must be >= grossAmount (base + 0.5% fee).`);

  const available = session.totalFunded - session.totalSpent;
  if (grossAmount > available)
    return err(400,
      `Insufficient funded balance: available ${available} gross units, required ${grossAmount}. ` +
      `(base ${baseAmount} + fee ${feeAmount} = gross ${grossAmount})`);

  // ── 10. Validate treasury is configured ──────────────────────────────────
  if (!config.treasuryAddress)
    return err(503, "Treasury address not configured on this server; V2 payments cannot be processed");

  // ── 11. Quote deadline ───────────────────────────────────────────────────
  const quoteWindowEnd = nowSecs + BigInt(config.quoteWindowSeconds);
  const minWindow = 60n;
  const timeToExpiry = session.expiresAt - nowSecs;
  if (timeToExpiry < minWindow)
    return err(400, "Session expires too soon; not enough time for a quote window");
  const deadline = (quoteWindowEnd < session.expiresAt ? quoteWindowEnd : session.expiresAt);

  // ── 12. Compute requestHash = SHA-256(input) ─────────────────────────────
  // H-04 fix (Part 10 audit): requestHash is included in the quote response.
  // The fulfillment endpoint verifies SHA-256(input) == quote.requestHash to
  // bind the result to the exact input that was paid for.
  const requestHash = await computeRequestHash(input);

  // ── 13. Generate requestId ────────────────────────────────────────────────
  const requestId = generateRequestId();

  // ── 14. Sign V2 quote ─────────────────────────────────────────────────────
  let signature: `0x${string}`;
  try {
    signature = await signQuoteV2(config, v2Contract, {
      sessionId,
      requestId,
      baseAmount,
      feeAmount,
      grossAmount,
      deadline,
      provider:  config.providerPayoutAddress as `0x${string}`,
      treasury:  config.treasuryAddress as `0x${string}`,
    });
  } catch { return err(500, "Failed to sign V2 quote; server error"); }

  // ── 15. Return quote ──────────────────────────────────────────────────────
  const response: SignedQuoteV2 = {
    sessionId,
    requestId,
    requestHash,          // H-04 fix: included so fulfill can verify input integrity
    baseAmount,
    feeAmount,
    grossAmount,
    deadline,
    provider:           config.providerPayoutAddress as `0x${string}`,
    treasury:           config.treasuryAddress as `0x${string}`,
    signature,
    chainId:            config.chainId,
    contractAddress:    v2Contract,
    quoteSignerAddress: expectedSigner as `0x${string}`,
    service:            "document-insights-v1",
    displayPrice:       formatV2DisplayPrice(baseAmount, feeAmount, grossAmount),
    version:            "2",
  };

  return jsonResponse(200, serializeQuoteV2(response));
}

function serializeQuoteV2(q: SignedQuoteV2): Record<string, unknown> {
  return {
    ...q,
    sessionId:   q.sessionId.toString(),
    baseAmount:  q.baseAmount.toString(),
    feeAmount:   q.feeAmount.toString(),
    grossAmount: q.grossAmount.toString(),
    deadline:    q.deadline.toString(),
  };
}

function err(status: number, message: string, retryable = false): Response {
  return jsonResponse(status, { error: message, retryable });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type":  "application/json",
      "Cache-Control": "no-store",
      "Pragma":        "no-cache",
    },
  });
}
