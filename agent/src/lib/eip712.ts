/**
 * EIP-712 verification helpers for the agent CLI.
 *
 * The agent does NOT sign anything — signing is done by the provider.
 * This module verifies that the provider's signed quote is authentic
 * before submitting a payment transaction.
 */

import { recoverTypedDataAddress } from "viem";
import { EIP712_NAME, EIP712_VERSION } from "./constants.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SignedQuote {
  sessionId:          string;   // bigint serialized as string
  requestId:          string;   // bytes32 hex
  requestHash:        string;   // bytes32 hex
  amount:             string;   // bigint serialized as string
  quoteDeadline:      string;   // bigint serialized as string
  signature:          `0x${string}`;
  chainId:            number;
  contractAddress:    `0x${string}`;
  providerPayout:     `0x${string}`;
  quoteSignerAddress: `0x${string}`;
  service:            string;
  displayPrice:       string;
}

// ── Domain & types ─────────────────────────────────────────────────────────

function buildDomain(chainId: number, contractAddress: `0x${string}`) {
  return {
    name:              EIP712_NAME as const,
    version:           EIP712_VERSION as const,
    chainId,
    verifyingContract: contractAddress,
  };
}

const PAYMENT_QUOTE_TYPES = {
  PaymentQuote: [
    { name: "sessionId",     type: "uint256" },
    { name: "requestId",     type: "bytes32" },
    { name: "requestHash",   type: "bytes32" },
    { name: "amount",        type: "uint256" },
    { name: "quoteDeadline", type: "uint64"  },
  ],
} as const;

// ── Request hash ───────────────────────────────────────────────────────────

/**
 * Compute requestHash = SHA-256 of exact UTF-8 bytes of input.
 * Must match the provider's computation exactly.
 */
export async function computeRequestHash(input: string): Promise<`0x${string}`> {
  const utf8Bytes  = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", utf8Bytes);
  const hex        = Buffer.from(hashBuffer).toString("hex");
  return `0x${hex}` as `0x${string}`;
}

// ── Quote validation ───────────────────────────────────────────────────────

export interface QuoteVerificationResult {
  valid:   true;
  message: string;
}

/**
 * Verifies a signed quote from the provider:
 *   1. Service identifier
 *   2. Chain ID and contract address
 *   3. Session ID matches
 *   4. Provider payout matches configured value
 *   5. Price matches configured fixed price
 *   6. requestHash matches SHA-256(input)
 *   7. Deadline is in the future
 *   8. EIP-712 signature recovers to the configured quote signer
 *
 * Throws a descriptive Error on any failure. Returns on success.
 */
export async function verifySignedQuote(
  quote: SignedQuote,
  input: string,
  sessionId: bigint,
  configuredChainId: number,
  configuredContract: `0x${string}`,
  configuredProvider: `0x${string}`,
  configuredSigner:   `0x${string}`,
  fixedPrice:         bigint,
): Promise<QuoteVerificationResult> {
  const now = BigInt(Math.floor(Date.now() / 1000));

  // 1. Service
  if (quote.service !== "document-insights-v1") {
    throw new Error(`Unknown service: ${quote.service}`);
  }

  // 2. Chain ID
  if (quote.chainId !== configuredChainId) {
    throw new Error(
      `Quote chainId ${quote.chainId} does not match configured ${configuredChainId}`
    );
  }

  // 3. Contract address
  if (quote.contractAddress.toLowerCase() !== configuredContract.toLowerCase()) {
    throw new Error(
      `Quote contractAddress ${quote.contractAddress} does not match ${configuredContract}`
    );
  }

  // 4. Session ID
  if (BigInt(quote.sessionId) !== sessionId) {
    throw new Error(
      `Quote sessionId ${quote.sessionId} does not match requested ${sessionId}`
    );
  }

  // 5. Provider payout
  if (quote.providerPayout.toLowerCase() !== configuredProvider.toLowerCase()) {
    throw new Error(
      `Quote providerPayout ${quote.providerPayout} does not match configured ${configuredProvider}. ` +
      `Paying would send USDC to the wrong address.`
    );
  }

  // 6. Amount
  if (BigInt(quote.amount) !== fixedPrice) {
    throw new Error(
      `Quote amount ${quote.amount} does not match expected fixed price ${fixedPrice}`
    );
  }

  // 7. requestHash
  const localHash = await computeRequestHash(input);
  if (quote.requestHash.toLowerCase() !== localHash.toLowerCase()) {
    throw new Error(
      `requestHash mismatch: server returned ${quote.requestHash}, ` +
      `local SHA-256 computed ${localHash}. Do NOT pay — input was altered.`
    );
  }

  // 8. Deadline
  const deadline = BigInt(quote.quoteDeadline);
  if (deadline <= now) {
    throw new Error(
      `Quote deadline ${deadline} is in the past (now ${now}). Request a fresh quote.`
    );
  }

  // 9. EIP-712 signature
  const domain = buildDomain(configuredChainId, configuredContract);
  const recovered = await recoverTypedDataAddress({
    domain,
    types: PAYMENT_QUOTE_TYPES,
    primaryType: "PaymentQuote",
    message: {
      sessionId:     BigInt(quote.sessionId),
      requestId:     quote.requestId as `0x${string}`,
      requestHash:   quote.requestHash as `0x${string}`,
      amount:        BigInt(quote.amount),
      quoteDeadline: BigInt(quote.quoteDeadline),
    },
    signature: quote.signature,
  });

  if (recovered.toLowerCase() !== configuredSigner.toLowerCase()) {
    throw new Error(
      `EIP-712 signature verification failed: recovered ${recovered}, ` +
      `expected ${configuredSigner}. Quote may have been tampered.`
    );
  }

  return { valid: true, message: "Quote verified: all fields match, signature valid" };
}
