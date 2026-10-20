/**
 * BudgetRail SDK — Quote request and verification.
 * No private keys. The SDK never signs on behalf of the agent.
 */

import { recoverTypedDataAddress } from "viem";
import { BudgetRailError } from "./types.js";
import type { BudgetRailConfig, SignedQuote, ProviderHealth } from "./types.js";

// ── Provider health ────────────────────────────────────────────────────────

/**
 * Check if the provider API is reachable and correctly configured.
 * Returns the health object; throws PROVIDER_UNREACHABLE on failure.
 */
export async function checkProviderHealth(config: BudgetRailConfig): Promise<ProviderHealth> {
  const url = `${config.providerApiUrl}/api/health`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  } catch (err) {
    throw new BudgetRailError("PROVIDER_UNREACHABLE", `Provider health check failed: ${(err as Error).message}`, true, err);
  }
  if (!res.ok) {
    throw new BudgetRailError("PROVIDER_UNREACHABLE", `Provider health returned ${res.status}`, true);
  }
  const body = await res.json() as ProviderHealth;
  // Verify chain ID matches config
  if (body.chainId !== config.chainId) {
    throw new BudgetRailError("WRONG_CHAIN", `Provider chain ${body.chainId} != configured ${config.chainId}`);
  }
  return body;
}

// ── requestQuote ────────────────────────────────────────────────────────────

export interface QuoteRequest {
  sessionId: bigint;
  service: string;
  input: string;
}

/**
 * Request a signed EIP-712 quote from the provider API.
 * Does NOT verify the signature — call verifyQuote afterward.
 * Never sends private keys; the quote is signed by the provider, not the agent.
 */
export async function requestQuote(
  config: BudgetRailConfig,
  req: QuoteRequest,
): Promise<SignedQuote> {
  const url = `${config.providerApiUrl}/api/quotes`;
  let res: Response;
  try {
    res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        sessionId: req.sessionId.toString(),
        service:   req.service,
        input:     req.input,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new BudgetRailError("PROVIDER_UNREACHABLE", `Quote request failed: ${(err as Error).message}`, true, err);
  }

  const body = await res.json() as Record<string, unknown>;

  if (!res.ok) {
    const msg = typeof body["error"] === "string" ? body["error"] : `HTTP ${res.status}`;
    throw new BudgetRailError("PROVIDER_UNREACHABLE", `Quote request failed: ${msg}`, res.status >= 500);
  }

  return normalizeQuote(body);
}

function normalizeQuote(raw: Record<string, unknown>): SignedQuote {
  return {
    sessionId:          BigInt(String(raw["sessionId"])),
    requestId:          String(raw["requestId"])          as `0x${string}`,
    requestHash:        String(raw["requestHash"])        as `0x${string}`,
    amount:             BigInt(String(raw["amount"])),
    quoteDeadline:      BigInt(String(raw["quoteDeadline"])),
    signature:          String(raw["signature"])          as `0x${string}`,
    chainId:            Number(raw["chainId"]),
    contractAddress:    String(raw["contractAddress"])    as `0x${string}`,
    providerPayout:     String(raw["providerPayout"])     as `0x${string}`,
    quoteSignerAddress: String(raw["quoteSignerAddress"]) as `0x${string}`,
    service:            String(raw["service"]),
    displayPrice:       String(raw["displayPrice"] ?? ""),
  };
}

// ── verifyQuote ────────────────────────────────────────────────────────────

/**
 * Locally verify a SignedQuote before submitting an onchain payment.
 * Checks: chain ID, contract, provider, signer address, amount cap, deadline,
 * requestHash computation, and EIP-712 signature recovery.
 *
 * @param quote        The signed quote from requestQuote.
 * @param inputText    The exact input string sent to the provider.
 * @param sessionId    The session ID the agent is paying for.
 * @param expectedCap  Maximum acceptable amount in base units (from perPaymentCap or a fixed price).
 */
export async function verifyQuote(
  config: BudgetRailConfig,
  quote: SignedQuote,
  inputText: string,
  sessionId: bigint,
  expectedCap: bigint,
): Promise<void> {
  // Chain
  if (quote.chainId !== config.chainId) {
    throw new BudgetRailError("WRONG_CHAIN", `Quote chainId ${quote.chainId} != config chainId ${config.chainId}`);
  }
  // Contract
  if (quote.contractAddress.toLowerCase() !== config.contractAddress.toLowerCase()) {
    throw new BudgetRailError("PROVIDER_MISMATCH", `Quote contract ${quote.contractAddress} != ${config.contractAddress}`);
  }
  // Provider
  if (quote.providerPayout.toLowerCase() !== config.providerPayout.toLowerCase()) {
    throw new BudgetRailError("PROVIDER_MISMATCH", `Quote provider ${quote.providerPayout} != config ${config.providerPayout}`);
  }
  // Signer
  if (quote.quoteSignerAddress.toLowerCase() !== config.quoteSigner.toLowerCase()) {
    throw new BudgetRailError("SIGNER_MISMATCH", `Quote signer ${quote.quoteSignerAddress} != config ${config.quoteSigner}`);
  }
  // Session ID
  if (quote.sessionId !== sessionId) {
    throw new BudgetRailError("SESSION_NOT_FOUND", `Quote sessionId ${quote.sessionId} != requested ${sessionId}`);
  }
  // Amount cap
  if (quote.amount > expectedCap) {
    throw new BudgetRailError("PER_PAYMENT_CAP_EXCEEDED", `Quote amount ${quote.amount} exceeds cap ${expectedCap}`);
  }
  // Deadline
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (quote.quoteDeadline < now) {
    throw new BudgetRailError("QUOTE_EXPIRED", `Quote deadline ${quote.quoteDeadline} is in the past (now=${now})`);
  }
  // requestHash
  const expectedHash = await computeRequestHash(inputText);
  if (quote.requestHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new BudgetRailError("PROVIDER_MISMATCH", "requestHash does not match SHA-256(input)");
  }
  // EIP-712 signature
  const recovered = await recoverTypedDataAddress({
    domain: {
      name: "BudgetRail",
      version: "1",
      chainId: quote.chainId,
      verifyingContract: quote.contractAddress,
    },
    types: {
      PaymentQuote: [
        { name: "sessionId",     type: "uint256" },
        { name: "requestId",     type: "bytes32" },
        { name: "requestHash",   type: "bytes32" },
        { name: "amount",        type: "uint256" },
        { name: "quoteDeadline", type: "uint64"  },
      ],
    },
    primaryType: "PaymentQuote",
    message: {
      sessionId:     quote.sessionId,
      requestId:     quote.requestId,
      requestHash:   quote.requestHash,
      amount:        quote.amount,
      quoteDeadline: quote.quoteDeadline,
    },
    signature: quote.signature,
  });

  if (recovered.toLowerCase() !== config.quoteSigner.toLowerCase()) {
    throw new BudgetRailError("INVALID_SIGNATURE", `Signature recovered ${recovered}, expected ${config.quoteSigner}`);
  }
}

// ── computeRequestHash ────────────────────────────────────────────────────

/**
 * Compute requestHash = SHA-256(UTF-8 bytes of input), hex-encoded as 0x{64 hex chars}.
 * Matches provider/src/lib/eip712.ts computeRequestHash.
 */
export async function computeRequestHash(input: string): Promise<`0x${string}`> {
  const utf8Bytes = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", utf8Bytes);
  return `0x${Buffer.from(hashBuffer).toString("hex")}` as `0x${string}`;
}
