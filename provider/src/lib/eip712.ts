/**
 * EIP-712 signing helpers for BudgetRail PaymentQuote.
 *
 * The quote signer D private key is consumed from config and NEVER
 * written to logs, responses, or exported from this module.
 */

import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type Config } from "./config.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface PaymentQuote {
  sessionId:     bigint;
  requestId:     `0x${string}`;  // bytes32 hex
  requestHash:   `0x${string}`;  // bytes32 hex — keccak256 of input
  amount:        bigint;          // uint256 in EIP-712 struct
  quoteDeadline: bigint;          // uint64 unix timestamp
}

export interface SignedQuote extends PaymentQuote {
  signature:           `0x${string}`;
  chainId:             number;
  contractAddress:     `0x${string}`;
  providerPayout:      `0x${string}`;
  quoteSignerAddress:  `0x${string}`;
  service:             "document-insights-v1";
  displayPrice:        string;
}

// ── Domain & typehash ──────────────────────────────────────────────────────

/** EIP-712 domain matching BudgetRail.sol constructor args */
export function buildDomain(chainId: number, contractAddress: `0x${string}`) {
  return {
    name:              "BudgetRail" as const,
    version:           "1" as const,
    chainId,
    verifyingContract: contractAddress,
  };
}

// Field order and types MUST match BudgetRail.sol PaymentQuote typehash exactly.
export const PAYMENT_QUOTE_TYPES = {
  PaymentQuote: [
    { name: "sessionId",     type: "uint256" },
    { name: "requestId",     type: "bytes32" },
    { name: "requestHash",   type: "bytes32" },
    { name: "amount",        type: "uint256" },
    { name: "quoteDeadline", type: "uint64"  },
  ],
} as const;

// ── SHA-256 requestHash ────────────────────────────────────────────────────

/**
 * Compute requestHash = SHA-256 of exact UTF-8 bytes of input, as bytes32.
 * Uses the Web Crypto API (available in Bun and Node 18+).
 */
export async function computeRequestHash(input: string): Promise<`0x${string}`> {
  const utf8Bytes = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", utf8Bytes);
  const hex = Buffer.from(hashBuffer).toString("hex");
  return `0x${hex}` as `0x${string}`;
}

// ── Signer address derivation ──────────────────────────────────────────────

export function quoteSignerAddressFromPrivKey(privateKey: `0x${string}`): `0x${string}` {
  return privateKeyToAccount(privateKey).address.toLowerCase() as `0x${string}`;
}

// ── Sign a quote ──────────────────────────────────────────────────────────

/**
 * Sign an EIP-712 PaymentQuote with the quote signer key D.
 * Private key is used in-process ONLY and never returned or logged.
 */
export async function signQuote(
  config: Config,
  quote: PaymentQuote,
): Promise<`0x${string}`> {
  const account = privateKeyToAccount(config.quoteSignerPrivateKey);
  const domain  = buildDomain(config.chainId, config.contractAddress);

  // walletClient.signTypedData handles the EIP-712 domain separator and encoding.
  const walletClient = createWalletClient({
    account,
    transport: http(config.rpcUrl),
  });

  const signature = await walletClient.signTypedData({
    account,
    domain,
    types: PAYMENT_QUOTE_TYPES,
    primaryType: "PaymentQuote",
    message: {
      sessionId:     quote.sessionId,
      requestId:     quote.requestId,
      requestHash:   quote.requestHash,
      amount:        quote.amount,
      quoteDeadline: quote.quoteDeadline,
    },
  });

  return signature;
}

// ── Generate a cryptographically random requestId ─────────────────────────

export function generateRequestId(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Buffer.from(bytes).toString("hex")}` as `0x${string}`;
}
