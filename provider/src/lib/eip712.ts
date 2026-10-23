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

// ═══════════════════════════════════════════════════════════════════════════
// V2 EIP-712 support
// ═══════════════════════════════════════════════════════════════════════════

/**
 * V2 quote typed data.
 * Fields MUST match BudgetRailV2.sol _PAYMENT_QUOTE_V2_TYPEHASH exactly.
 * DO NOT add, remove or reorder fields without updating the contract typehash.
 */
export interface PaymentQuoteV2 {
  sessionId:   bigint;
  requestId:   `0x${string}`; // bytes32
  baseAmount:  bigint;
  feeAmount:   bigint;
  grossAmount: bigint;
  deadline:    bigint;        // uint64 stored as bigint
  provider:    `0x${string}`; // provider C — locked in signed data
  treasury:    `0x${string}`; // treasury E — prevents fee redirection
}

export interface SignedQuoteV2 extends PaymentQuoteV2 {
  signature:          `0x${string}`;
  chainId:            number;
  contractAddress:    `0x${string}`;
  quoteSignerAddress: `0x${string}`;
  service:            "document-insights-v1";
  /** SHA-256(input) — binds the quote to the exact paid input.
   *  Required in /api/fulfill/v2 to verify input integrity (H-04 fix). */
  requestHash:        `0x${string}`;
  /** Human-readable breakdown, e.g. "$0.050000 + $0.000250 fee = $0.050250" */
  displayPrice:       string;
  /** version tag so callers can distinguish V1 from V2 quotes */
  version:            "2";
}

/** EIP-712 domain for BudgetRailV2 — version MUST be "2". */
export function buildDomainV2(chainId: number, contractAddress: `0x${string}`) {
  return {
    name:              "BudgetRail" as const,
    version:           "2" as const,
    chainId,
    verifyingContract: contractAddress,
  };
}

/** Field order MUST match BudgetRailV2.sol typehash. */
export const PAYMENT_QUOTE_V2_TYPES = {
  PaymentQuoteV2: [
    { name: "sessionId",   type: "uint256" },
    { name: "requestId",   type: "bytes32" },
    { name: "baseAmount",  type: "uint256" },
    { name: "feeAmount",   type: "uint256" },
    { name: "grossAmount", type: "uint256" },
    { name: "deadline",    type: "uint256" },
    { name: "provider",    type: "address" },
    { name: "treasury",    type: "address" },
  ],
} as const;

/**
 * Compute V2 fee split from baseAmount using exact integer math.
 * Matches BudgetRailV2.sol: feeAmount = floor(baseAmount * 50 / 10_000).
 * grossAmount = baseAmount + feeAmount.
 * NEVER uses floating point for authorization calculations.
 */
export function computeV2Fee(baseAmount: bigint): { feeAmount: bigint; grossAmount: bigint } {
  const feeAmount   = (baseAmount * 50n) / 10_000n;
  const grossAmount = baseAmount + feeAmount;
  return { feeAmount, grossAmount };
}

/**
 * Sign a V2 EIP-712 PaymentQuoteV2.
 * Private key is used in-process ONLY and never returned or logged.
 */
export async function signQuoteV2(
  config: Config,
  v2ContractAddress: `0x${string}`,
  quote: PaymentQuoteV2,
): Promise<`0x${string}`> {
  const account = privateKeyToAccount(config.quoteSignerPrivateKey);
  const domain  = buildDomainV2(config.chainId, v2ContractAddress);

  const walletClient = createWalletClient({
    account,
    transport: http(config.rpcUrl),
  });

  return walletClient.signTypedData({
    account,
    domain,
    types: PAYMENT_QUOTE_V2_TYPES,
    primaryType: "PaymentQuoteV2",
    message: {
      sessionId:   quote.sessionId,
      requestId:   quote.requestId,
      baseAmount:  quote.baseAmount,
      feeAmount:   quote.feeAmount,
      grossAmount: quote.grossAmount,
      deadline:    quote.deadline,
      provider:    quote.provider,
      treasury:    quote.treasury,
    },
  });
}

/** Format a human-readable V2 price breakdown. */
export function formatV2DisplayPrice(baseAmount: bigint, feeAmount: bigint, grossAmount: bigint): string {
  const fmt = (u: bigint) => `$${(Number(u) / 1_000_000).toFixed(6)} USDC`;
  return `${fmt(baseAmount)} base + ${fmt(feeAmount)} platform fee = ${fmt(grossAmount)} total`;
}
