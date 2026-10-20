/**
 * POST /api/quotes
 *
 * Issues a signed EIP-712 PaymentQuote for the Document Insights v1 service.
 * No funds move here.  The quote must be used by agent B to call
 * BudgetRail.payForRequest() onchain; the provider NEVER returns a result here.
 *
 * Request body (JSON):
 *   { sessionId: string, service: "document-insights-v1", input: string }
 *
 * Security properties:
 *   - Server determines price; user-provided amount is ignored.
 *   - Server reads session from chain; validates open/not-expired/matching config.
 *   - requestHash = SHA-256(exact UTF-8 bytes of input) — binds quote to content.
 *   - requestId   = 32 random bytes — unpredictable per quote.
 *   - Quote signer D private key is never exposed; only the public address is shown.
 *   - Server DOES NOT move any funds; signing is quote-only.
 */

import { type Config } from "../lib/config.js";
import { readSession } from "../lib/onchain.js";
import {
  computeRequestHash,
  generateRequestId,
  signQuote,
  quoteSignerAddressFromPrivKey,
  type SignedQuote,
} from "../lib/eip712.js";
import { checkRateLimit } from "../lib/ratelimit.js";

const SUPPORTED_SERVICES = new Set(["document-insights-v1"]);

export async function handleQuotes(config: Config, req: Request): Promise<Response> {
  // ── 0. Parse body ────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }

  if (typeof body !== "object" || body === null) return err(400, "Body must be a JSON object");
  const { sessionId: rawSessionId, service, input } = body as Record<string, unknown>;

  // ── 1. Validate service ──────────────────────────────────────────────────
  if (typeof service !== "string" || !SUPPORTED_SERVICES.has(service)) {
    return err(400, `Unsupported service. Supported: ${[...SUPPORTED_SERVICES].join(", ")}`);
  }

  // ── 2. Validate input ────────────────────────────────────────────────────
  if (typeof input !== "string") return err(400, "input must be a string");
  const inputBytes = new TextEncoder().encode(input);
  if (inputBytes.length === 0)               return err(400, "input must not be empty");
  if (inputBytes.length > config.maxInputBytes)
    return err(400, `input exceeds ${config.maxInputBytes} bytes (${inputBytes.length} received)`);

  // ── 3. Validate sessionId ────────────────────────────────────────────────
  if (typeof rawSessionId !== "string" && typeof rawSessionId !== "number")
    return err(400, "sessionId must be a string or number");

  let sessionId: bigint;
  try {
    sessionId = BigInt(rawSessionId as string);
    if (sessionId <= 0n) throw new Error("non-positive");
  } catch {
    return err(400, "sessionId must be a positive integer");
  }

  // ── 4. Rate limit per sessionId ──────────────────────────────────────────
  if (!checkRateLimit(`quotes:${sessionId}`, config.rateLimitPerMinute)) {
    return err(429, "Too many quote requests for this session; retry after 60 seconds");
  }

  // ── 5. Read session from chain ───────────────────────────────────────────
  let session;
  try {
    session = await readSession(config, sessionId);
  } catch {
    return err(503, "Failed to read session from chain; RPC may be unavailable", true);
  }
  if (!session) return err(404, `Session ${sessionId} not found on chain`);

  // ── 6. Validate session state ────────────────────────────────────────────
  if (session.closed)
    return err(400, "Session is closed");

  const nowSecs = BigInt(Math.floor(Date.now() / 1000));
  if (nowSecs > session.expiresAt)
    return err(400, "Session has expired");

  // ── 7. Validate provider and signer match server config ──────────────────
  if (session.provider.toLowerCase() !== config.providerPayoutAddress.toLowerCase()) {
    return err(400, "Session provider does not match this server's payout address");
  }

  const expectedSigner = quoteSignerAddressFromPrivKey(config.quoteSignerPrivateKey);
  if (session.quoteSigner.toLowerCase() !== expectedSigner.toLowerCase()) {
    return err(400, "Session quoteSigner does not match this server's signing key");
  }

  // ── 8. Validate price fits cap and remaining budget ──────────────────────
  const price = config.pricePerCall;
  if (price > session.perPaymentCap) {
    return err(400, `Service price (${price}) exceeds session perPaymentCap (${session.perPaymentCap})`);
  }
  const available = session.totalFunded - session.totalSpent;
  if (price > available) {
    return err(400, `Insufficient funded balance: available ${available}, required ${price}`);
  }

  // ── 9. Validate quote deadline ────────────────────────────────────────────
  const quoteWindowEnd = nowSecs + BigInt(config.quoteWindowSeconds);
  // Clamp to session expiry; if session expires in < 60 seconds, refuse.
  const minWindow = 60n;
  const timeToExpiry = session.expiresAt - nowSecs;
  if (timeToExpiry < minWindow) {
    return err(400, "Session expires too soon; not enough time for a quote window");
  }
  const quoteDeadline = quoteWindowEnd < session.expiresAt ? quoteWindowEnd : session.expiresAt;

  // ── 10. Compute requestHash = SHA-256(exact UTF-8 input) ─────────────────
  const requestHash = await computeRequestHash(input);

  // ── 11. Generate unpredictable requestId ─────────────────────────────────
  const requestId = generateRequestId();

  // ── 12. Sign the quote ────────────────────────────────────────────────────
  let signature: `0x${string}`;
  try {
    signature = await signQuote(config, {
      sessionId,
      requestId,
      requestHash,
      amount: price,
      quoteDeadline,
    });
  } catch {
    return err(500, "Failed to sign quote; server error");
  }

  // ── 13. Return quote (no result, no paid content) ─────────────────────────
  const response: SignedQuote = {
    sessionId,
    requestId,
    requestHash,
    amount:           price,
    quoteDeadline,
    signature,
    chainId:          config.chainId,
    contractAddress:  config.contractAddress,
    providerPayout:   config.providerPayoutAddress as `0x${string}`,
    quoteSignerAddress: expectedSigner as `0x${string}`,
    service:          "document-insights-v1",
    displayPrice:     `$${(Number(price) / 1_000_000).toFixed(2)} USDC`,
  };

  return jsonResponse(200, serializeQuote(response));
}

// BigInt fields must be serialised as strings for JSON transport.
function serializeQuote(q: SignedQuote): Record<string, unknown> {
  return {
    ...q,
    sessionId:     q.sessionId.toString(),
    amount:        q.amount.toString(),
    quoteDeadline: q.quoteDeadline.toString(),
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
