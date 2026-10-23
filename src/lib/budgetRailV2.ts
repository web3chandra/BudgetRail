/**
 * BudgetRail V2 contract ABI, fee math, and address helpers.
 *
 * V2 adds an immutable 0.5% (50 bps) platform fee ON TOP of the provider's
 * base price. All fee arithmetic uses integer bigint — never floats.
 *
 * Fee formula (matches contract exactly):
 *   feeAmount  = floor(baseAmount * 50 / 10_000)
 *   grossAmount = baseAmount + feeAmount
 *
 * V2 contract address and treasury are read from:
 *   VITE_BUDGET_RAIL_V2_ADDRESS  — deployed V2 contract
 *   VITE_TREASURY_ADDRESS        — immutable treasury E address
 *
 * NEVER import V1 ABI for V2 events or vice versa.
 */

import { ARC } from "@/lib/arcProfile";

export const FEE_BPS        = 50n;
export const FEE_DENOMINATOR = 10_000n;

// ── V2 addresses from profile ────────────────────────────────────────────────

export const BUDGET_RAIL_V2_ADDRESS: `0x${string}` = ARC.v2ContractAddress;
export const TREASURY_ADDRESS:       `0x${string}` = ARC.treasuryAddress;

// ── Fee computation ──────────────────────────────────────────────────────────

export interface FeeBreakdown {
  baseAmount:  bigint; // provider C receives this
  feeAmount:   bigint; // treasury E receives this (may be 0 for very small base)
  grossAmount: bigint; // session is debited this; cap must be >= this
}

/**
 * Compute V2 fee breakdown from a provider base amount.
 * Uses exact integer math matching the Solidity contract:
 *   feeAmount = floor(baseAmount * 50 / 10_000)
 *   grossAmount = baseAmount + feeAmount
 *
 * For base = 50_000 µUSDC ($0.05):
 *   fee  = floor(50_000 * 50 / 10_000) = 250 µUSDC  ($0.000250)
 *   gross = 50_250 µUSDC               ($0.050250)
 *
 * Zero fee is possible for very small base amounts and is disclosed, not hidden.
 */
export function computeFeeV2(baseAmount: bigint): FeeBreakdown {
  if (baseAmount < 0n) throw new Error("baseAmount must be non-negative");
  const feeAmount  = (baseAmount * FEE_BPS) / FEE_DENOMINATOR; // floor division
  const grossAmount = baseAmount + feeAmount;
  return { baseAmount, feeAmount, grossAmount };
}

/**
 * Verify that a caller-supplied fee matches the contract formula.
 * Use this in the frontend before displaying or confirming a V2 quote.
 */
export function verifyFeeV2(base: bigint, fee: bigint): boolean {
  return fee === (base * FEE_BPS) / FEE_DENOMINATOR;
}

/**
 * Returns the minimum gross amount required so a given cap allows a V2 payment.
 * cap >= grossAmount is the contract check.
 */
export function minCapForBaseV2(baseAmount: bigint): bigint {
  return computeFeeV2(baseAmount).grossAmount;
}

// ── V2 ABI ───────────────────────────────────────────────────────────────────

export const BUDGET_RAIL_V2_ABI = [
  // ── Reads ──────────────────────────────────────────────────────────────
  {
    "type": "function", "name": "getSession",
    "inputs":  [{ "name": "sessionId", "type": "uint256" }],
    "outputs": [{ "name": "", "type": "tuple", "components": [
      { "name": "owner",         "type": "address" },
      { "name": "agent",         "type": "address" },
      { "name": "provider",      "type": "address" },
      { "name": "quoteSigner",   "type": "address" },
      { "name": "maxBudget",     "type": "uint96"  },
      { "name": "perPaymentCap", "type": "uint96"  },
      { "name": "totalFunded",   "type": "uint96"  },
      { "name": "totalSpent",    "type": "uint96"  },
      { "name": "expiresAt",     "type": "uint64"  },
      { "name": "closed",        "type": "bool"    }
    ]}],
    "stateMutability": "view"
  },
  {
    "type": "function", "name": "availableBalance",
    "inputs":  [{ "name": "sessionId", "type": "uint256" }],
    "outputs": [{ "name": "", "type": "uint96" }],
    "stateMutability": "view"
  },
  {
    "type": "function", "name": "TREASURY",
    "inputs": [],
    "outputs": [{ "name": "", "type": "address" }],
    "stateMutability": "view"
  },
  {
    "type": "function", "name": "FEE_BPS",
    "inputs": [],
    "outputs": [{ "name": "", "type": "uint256" }],
    "stateMutability": "view"
  },
  {
    "type": "function", "name": "computeFee",
    "inputs":  [{ "name": "baseAmount", "type": "uint256" }],
    "outputs": [{ "name": "fee", "type": "uint256" }],
    "stateMutability": "view"
  },
  {
    "type": "function", "name": "USDC_ADDRESS",
    "inputs": [],
    "outputs": [{ "name": "", "type": "address" }],
    "stateMutability": "view"
  },
  {
    "type": "function", "name": "ownerSessionCount",
    "inputs":  [{ "name": "owner", "type": "address" }],
    "outputs": [{ "name": "", "type": "uint256" }],
    "stateMutability": "view"
  },
  {
    "type": "function", "name": "sessionIdsByOwner",
    "inputs":  [
      { "name": "owner",  "type": "address" },
      { "name": "offset", "type": "uint256" },
      { "name": "limit",  "type": "uint256" }
    ],
    "outputs": [{ "name": "ids", "type": "uint256[]" }],
    "stateMutability": "view"
  },
  // ── Writes ──────────────────────────────────────────────────────────────
  {
    "type": "function", "name": "createSession",
    "inputs": [
      { "name": "agent",         "type": "address" },
      { "name": "provider",      "type": "address" },
      { "name": "quoteSigner",   "type": "address" },
      { "name": "maxBudget",     "type": "uint96"  },
      { "name": "perPaymentCap", "type": "uint96"  },
      { "name": "expiresAt",     "type": "uint64"  }
    ],
    "outputs": [{ "name": "sessionId", "type": "uint256" }],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function", "name": "fundSession",
    "inputs": [
      { "name": "sessionId", "type": "uint256" },
      { "name": "amount",    "type": "uint96"  }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function", "name": "payForRequestV2",
    "inputs": [
      { "name": "sessionId",         "type": "uint256" },
      { "name": "requestId",         "type": "bytes32" },
      { "name": "requestHash",       "type": "bytes32" },
      { "name": "baseAmount",        "type": "uint96"  },
      { "name": "feeAmount",         "type": "uint96"  },
      { "name": "quoteDeadline",     "type": "uint64"  },
      { "name": "providerSignature", "type": "bytes"   }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function", "name": "closeSession",
    "inputs": [{ "name": "sessionId", "type": "uint256" }],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  // ── Errors ───────────────────────────────────────────────────────────────
  { "type": "error", "name": "ZeroAddress",               "inputs": [] },
  { "type": "error", "name": "ZeroTreasury",              "inputs": [] },
  { "type": "error", "name": "InvalidBudget",             "inputs": [] },
  { "type": "error", "name": "InvalidPerPaymentCap",      "inputs": [] },
  { "type": "error", "name": "ExpiryInPast",              "inputs": [] },
  { "type": "error", "name": "SessionNotFound",           "inputs": [] },
  { "type": "error", "name": "NotOwner",                  "inputs": [] },
  { "type": "error", "name": "NotAgent",                  "inputs": [] },
  { "type": "error", "name": "SessionAlreadyClosed",      "inputs": [] },
  { "type": "error", "name": "SessionExpired",            "inputs": [] },
  { "type": "error", "name": "ZeroAmount",                "inputs": [] },
  { "type": "error", "name": "FundedBudgetExceeded",      "inputs": [] },
  { "type": "error", "name": "LifetimeBudgetExceeded",    "inputs": [] },
  { "type": "error", "name": "PerPaymentCapExceeded",     "inputs": [] },
  { "type": "error", "name": "QuoteExpired",              "inputs": [] },
  { "type": "error", "name": "QuoteDeadlineExceedsSession","inputs": [] },
  { "type": "error", "name": "RequestAlreadyPaid",        "inputs": [] },
  { "type": "error", "name": "InvalidSignature",          "inputs": [] },
  { "type": "error", "name": "InvalidFeeAmount",          "inputs": [] },
  { "type": "error", "name": "InvalidOffset",             "inputs": [] },
  // ── Events ──────────────────────────────────────────────────────────────
  {
    "type": "event", "name": "SessionCreated",
    "inputs": [
      { "name": "sessionId",    "type": "uint256", "indexed": true  },
      { "name": "owner",        "type": "address", "indexed": true  },
      { "name": "agent",        "type": "address", "indexed": true  },
      { "name": "provider",     "type": "address", "indexed": false },
      { "name": "quoteSigner",  "type": "address", "indexed": false },
      { "name": "maxBudget",    "type": "uint96",  "indexed": false },
      { "name": "perPaymentCap","type": "uint96",  "indexed": false },
      { "name": "expiresAt",    "type": "uint64",  "indexed": false }
    ]
  },
  {
    "type": "event", "name": "SessionFunded",
    "inputs": [
      { "name": "sessionId",   "type": "uint256", "indexed": true  },
      { "name": "owner",       "type": "address", "indexed": true  },
      { "name": "amount",      "type": "uint96",  "indexed": false },
      { "name": "totalFunded", "type": "uint96",  "indexed": false }
    ]
  },
  {
    "type": "event", "name": "PaymentSettledV2",
    "inputs": [
      { "name": "sessionId",    "type": "uint256", "indexed": true  },
      { "name": "requestId",    "type": "bytes32", "indexed": true  },
      { "name": "provider",     "type": "address", "indexed": true  },
      { "name": "treasury",     "type": "address", "indexed": false },
      { "name": "requestHash",  "type": "bytes32", "indexed": false },
      { "name": "agent",        "type": "address", "indexed": false },
      { "name": "baseAmount",   "type": "uint96",  "indexed": false },
      { "name": "feeAmount",    "type": "uint96",  "indexed": false },
      { "name": "grossAmount",  "type": "uint96",  "indexed": false },
      { "name": "quoteDeadline","type": "uint64",  "indexed": false }
    ]
  },
  {
    "type": "event", "name": "SessionClosed",
    "inputs": [
      { "name": "sessionId",  "type": "uint256", "indexed": true  },
      { "name": "owner",      "type": "address", "indexed": true  },
      { "name": "refunded",   "type": "uint96",  "indexed": false },
      { "name": "totalSpent", "type": "uint96",  "indexed": false }
    ]
  }
] as const;

export type SessionTupleV2 = {
  owner:         `0x${string}`;
  agent:         `0x${string}`;
  provider:      `0x${string}`;
  quoteSigner:   `0x${string}`;
  maxBudget:     bigint;
  perPaymentCap: bigint;
  totalFunded:   bigint;
  totalSpent:    bigint;
  expiresAt:     bigint;
  closed:        boolean;
};
