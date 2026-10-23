/**
 * BudgetRail SDK — Quote request and verification.
 * No private keys. The SDK never signs on behalf of the agent.
 */

import { recoverTypedDataAddress } from "viem";
import { BudgetRailError, computeV2Fee } from "./types.js";
import type { BudgetRailConfig, BudgetRailV2Config, SignedQuote, SignedQuoteV2, V2FeePrice, ProviderHealth } from "./types.js";

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

// ── V2 quote functions ────────────────────────────────────────────────────

export interface QuoteRequestV2 {
  sessionId: bigint;
  service: string;
  input: string;
}

/**
 * Request a V2 signed quote from the provider API (/api/quotes/v2).
 * The returned quote includes the full base/fee/gross breakdown.
 * Call verifyQuoteV2 before submitting the payment.
 */
export async function requestQuoteV2(
  config: BudgetRailV2Config,
  req: QuoteRequestV2,
): Promise<SignedQuoteV2> {
  const url = `${config.providerApiUrl}/api/quotes/v2`;
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
    throw new BudgetRailError("PROVIDER_UNREACHABLE", `V2 quote request failed: ${(err as Error).message}`, true, err);
  }

  const body = await res.json() as Record<string, unknown>;

  if (!res.ok) {
    const msg = typeof body["error"] === "string" ? body["error"] : `HTTP ${res.status}`;
    throw new BudgetRailError("PROVIDER_UNREACHABLE", `V2 quote request failed: ${msg}`, res.status >= 500);
  }

  return normalizeQuoteV2(body);
}

function normalizeQuoteV2(raw: Record<string, unknown>): SignedQuoteV2 {
  const baseAmount  = BigInt(String(raw["baseAmount"]  ?? raw["amount"] ?? "0"));
  const feeAmount   = BigInt(String(raw["feeAmount"]   ?? "0"));
  const grossAmount = BigInt(String(raw["grossAmount"] ?? String(baseAmount + feeAmount)));
  const fee = computeV2Fee(baseAmount);

  return {
    version:            "2",
    sessionId:          BigInt(String(raw["sessionId"])),
    requestId:          String(raw["requestId"])          as `0x${string}`,
    requestHash:        String(raw["requestHash"])        as `0x${string}`,
    baseAmount,
    feeAmount,
    grossAmount,
    quoteDeadline:      BigInt(String(raw["quoteDeadline"])),
    signature:          String(raw["signature"])          as `0x${string}`,
    chainId:            Number(raw["chainId"]),
    contractAddress:    String(raw["contractAddress"])    as `0x${string}`,
    providerPayout:     String(raw["providerPayout"])     as `0x${string}`,
    treasuryAddress:    String(raw["treasury"] ?? raw["treasuryAddress"] ?? config_treasury_placeholder) as `0x${string}`,
    quoteSignerAddress: String(raw["quoteSignerAddress"]) as `0x${string}`,
    service:            String(raw["service"]),
    displayBreakdown:   (typeof raw["displayBreakdown"] === "string") ? raw["displayBreakdown"] : fee.displayBreakdown,
  };
}

// Placeholder replaced at call site — kept as sentinel for raw normalizer
const config_treasury_placeholder = "0x0000000000000000000000000000000000000000";

/**
 * Locally verify a V2 SignedQuote before submitting onchain payment.
 *
 * Checks (all throw BudgetRailError on failure):
 *  - Chain ID matches config
 *  - Contract address is the V2 contract
 *  - Provider payout matches config
 *  - Treasury matches config.treasuryAddress
 *  - Signer matches config.quoteSigner
 *  - Session ID matches requested session
 *  - Fee arithmetic: feeAmount == floor(baseAmount * 50 / 10_000)
 *  - Gross cap: grossAmount <= expectedGrossCap
 *  - Quote not expired
 *  - requestHash == SHA-256(input)
 *  - EIP-712 signature from V2 domain
 *
 * @param expectedGrossCap  Max acceptable gross amount (use session.perPaymentCap).
 *                          Cap checks MUST be on gross, not base, for V2.
 */
export async function verifyQuoteV2(
  config: BudgetRailV2Config,
  quote: SignedQuoteV2,
  inputText: string,
  sessionId: bigint,
  expectedGrossCap: bigint,
): Promise<V2FeePrice> {
  // Chain
  if (quote.chainId !== config.chainId) {
    throw new BudgetRailError("WRONG_CHAIN", `V2 quote chainId ${quote.chainId} != config ${config.chainId}`);
  }
  // Contract — must be V2
  if (quote.contractAddress.toLowerCase() !== config.v2ContractAddress.toLowerCase()) {
    throw new BudgetRailError("PROVIDER_MISMATCH", `V2 quote contract ${quote.contractAddress} != ${config.v2ContractAddress}`);
  }
  // Provider
  if (quote.providerPayout.toLowerCase() !== config.providerPayout.toLowerCase()) {
    throw new BudgetRailError("PROVIDER_MISMATCH", `V2 provider ${quote.providerPayout} != config ${config.providerPayout}`);
  }
  // Treasury E
  if (quote.treasuryAddress.toLowerCase() !== config.treasuryAddress.toLowerCase()) {
    throw new BudgetRailError("PROVIDER_MISMATCH", `V2 treasury ${quote.treasuryAddress} != config ${config.treasuryAddress}`);
  }
  // Signer
  if (quote.quoteSignerAddress.toLowerCase() !== config.quoteSigner.toLowerCase()) {
    throw new BudgetRailError("SIGNER_MISMATCH", `V2 signer ${quote.quoteSignerAddress} != config ${config.quoteSigner}`);
  }
  // Session
  if (quote.sessionId !== sessionId) {
    throw new BudgetRailError("SESSION_NOT_FOUND", `V2 quote sessionId ${quote.sessionId} != requested ${sessionId}`);
  }
  // Fee arithmetic
  const expected = computeV2Fee(quote.baseAmount);
  if (quote.feeAmount !== expected.feeUnits) {
    throw new BudgetRailError(
      "PROVIDER_MISMATCH",
      `V2 fee mismatch: got ${quote.feeAmount}, expected ${expected.feeUnits} (floor(${quote.baseAmount} * 50 / 10000))`,
    );
  }
  if (quote.grossAmount !== expected.grossUnits) {
    throw new BudgetRailError(
      "PROVIDER_MISMATCH",
      `V2 gross mismatch: got ${quote.grossAmount}, expected ${expected.grossUnits}`,
    );
  }
  // Gross cap
  if (quote.grossAmount > expectedGrossCap) {
    throw new BudgetRailError(
      "PER_PAYMENT_CAP_EXCEEDED",
      `V2 grossAmount ${quote.grossAmount} exceeds perPaymentCap ${expectedGrossCap}`,
    );
  }
  // Deadline
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (quote.quoteDeadline < now) {
    throw new BudgetRailError("QUOTE_EXPIRED", `V2 quote deadline ${quote.quoteDeadline} in the past (now=${now})`);
  }
  // requestHash
  const expectedHash = await computeRequestHash(inputText);
  if (quote.requestHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new BudgetRailError("PROVIDER_MISMATCH", "V2 requestHash does not match SHA-256(input)");
  }
  // EIP-712 signature — V2 domain version "2", includes treasury
  const recovered = await recoverTypedDataAddress({
    domain: {
      name:              "BudgetRailV2",
      version:           "2",
      chainId:           quote.chainId,
      verifyingContract: quote.contractAddress,
    },
    types: {
      PaymentQuoteV2: [
        { name: "sessionId",      type: "uint256" },
        { name: "requestId",      type: "bytes32" },
        { name: "requestHash",    type: "bytes32" },
        { name: "baseAmount",     type: "uint256" },
        { name: "feeAmount",      type: "uint256" },
        { name: "treasury",       type: "address" },
        { name: "quoteDeadline",  type: "uint64"  },
      ],
    },
    primaryType: "PaymentQuoteV2",
    message: {
      sessionId:     quote.sessionId,
      requestId:     quote.requestId,
      requestHash:   quote.requestHash,
      baseAmount:    quote.baseAmount,
      feeAmount:     quote.feeAmount,
      treasury:      quote.treasuryAddress,
      quoteDeadline: quote.quoteDeadline,
    },
    signature: quote.signature,
  });

  if (recovered.toLowerCase() !== config.quoteSigner.toLowerCase()) {
    throw new BudgetRailError("INVALID_SIGNATURE", `V2 sig recovered ${recovered}, expected ${config.quoteSigner}`);
  }

  return expected;
}

/** Re-export for external use (offline fee preview). */
export { computeV2Fee } from "./types.js";
export type { V2FeePrice } from "./types.js";
