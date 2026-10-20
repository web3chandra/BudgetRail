/**
 * BudgetRail contract ABI + address config for the frontend.
 *
 * Required env vars (set in .env, never committed):
 *   VITE_BUDGET_RAIL_ADDRESS  — deployed contract (defaults to Arc Testnet deployment)
 *   VITE_PROVIDER_PAYOUT      — provider payout wallet C (role C, public address, non-zero)
 *   VITE_QUOTE_SIGNER         — quote signer public address D (role D, public address, non-zero)
 *   VITE_PROVIDER_API_URL     — provider API origin, NO trailing /api (default: "" = Vite proxy).
 *                              Examples: "" (proxy), "http://localhost:3001" (direct).
 *                              Do NOT set to "/api" — routes like /api/quotes are appended by code.
 *
 * SECURITY: VITE_* values are bundled into the browser. They must be public addresses only.
 * Never put private keys, entity secrets, or bearer tokens in VITE_* vars.
 */

const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;

function readAddr(envKey: string, fallback: `0x${string}`): `0x${string}` {
  const raw = String(import.meta.env[envKey] ?? fallback);
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return ZERO;
  return raw.toLowerCase() as `0x${string}`;
}

export const BUDGET_RAIL_ADDRESS: `0x${string}` = readAddr(
  "VITE_BUDGET_RAIL_ADDRESS",
  "0xf6a13df15ad93c2e2968e1d69c53894a923bda21",
);

// Strip a trailing /api if the operator mistakenly included it in the env var.
// The correct value is the origin only (e.g. "" for Vite proxy, or
// "http://localhost:3001" for direct access). Routes are appended as /api/quotes etc.
export const PROVIDER_API_URL: string = (() => {
  const raw = String(import.meta.env["VITE_PROVIDER_API_URL"] ?? "");
  // Remove any trailing /api (with or without trailing slash) so that
  // `${PROVIDER_API_URL}/api/quotes` never becomes `/api/api/quotes`.
  return raw.replace(/\/api\/?$/, "").replace(/\/$/, "");
})();

// These MUST be non-zero real addresses set by the operator.
// If either is zero the frontend will refuse to open a createSession wallet request.
// Kept here for backward compatibility — values come from arcProfile.
export const PROVIDER_PAYOUT: `0x${string}` = readAddr("VITE_PROVIDER_PAYOUT", ZERO);
export const QUOTE_SIGNER:    `0x${string}` = readAddr("VITE_QUOTE_SIGNER",    ZERO);

// ── ABI ───────────────────────────────────────────────────────────────────────

export const BUDGET_RAIL_ABI = [
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
  {
    "type": "function", "name": "USDC_ADDRESS",
    "inputs": [],
    "outputs": [{ "name": "", "type": "address" }],
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
    "type": "function", "name": "payForRequest",
    "inputs": [
      { "name": "sessionId",         "type": "uint256" },
      { "name": "requestId",         "type": "bytes32" },
      { "name": "requestHash",       "type": "bytes32" },
      { "name": "amount",            "type": "uint96"  },
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
  { "type": "error", "name": "InvalidBudget",             "inputs": [] },
  { "type": "error", "name": "InvalidPerPaymentCap",      "inputs": [] },
  { "type": "error", "name": "ExpiryInPast",              "inputs": [] },
  { "type": "error", "name": "SessionNotFound",           "inputs": [] },
  { "type": "error", "name": "NotOwner",                  "inputs": [] },
  { "type": "error", "name": "NotAgent",                  "inputs": [] },
  { "type": "error", "name": "SessionAlreadyClosed",      "inputs": [] },
  { "type": "error", "name": "SessionExpired",            "inputs": [] },
  { "type": "error", "name": "ZeroAmount",                "inputs": [] },
  { "type": "error", "name": "BudgetExceeded",            "inputs": [] },
  { "type": "error", "name": "FundedBudgetExceeded",      "inputs": [] },
  { "type": "error", "name": "LifetimeBudgetExceeded",    "inputs": [] },
  { "type": "error", "name": "PerPaymentCapExceeded",     "inputs": [] },
  { "type": "error", "name": "QuoteExpired",              "inputs": [] },
  { "type": "error", "name": "QuoteDeadlineExceedsSession","inputs": [] },
  { "type": "error", "name": "RequestAlreadyPaid",        "inputs": [] },
  { "type": "error", "name": "InvalidSignature",          "inputs": [] },
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
    "type": "event", "name": "PaymentSettled",
    "inputs": [
      { "name": "sessionId",    "type": "uint256", "indexed": true  },
      { "name": "requestId",    "type": "bytes32", "indexed": true  },
      { "name": "provider",     "type": "address", "indexed": true  },
      { "name": "requestHash",  "type": "bytes32", "indexed": false },
      { "name": "agent",        "type": "address", "indexed": false },
      { "name": "amount",       "type": "uint96",  "indexed": false },
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

export type SessionTuple = {
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

// ── Deploy constants (for event scanning lower bound) ─────────────────────

/** Block number at which BudgetRail was deployed on Arc Testnet. */
export const DEPLOY_BLOCK_TESTNET = 67538363n;

// ── Re-export profile helpers (single import point for pages) ─────────────
// Pages should import BUDGET_RAIL_ADDRESS, PROVIDER_CONFIGURED, providerConfigError,
// QUOTE_SIGNER from here for backward compatibility.
// For chain ID, explorer URL, RPC URL — import ARC from @/lib/arcProfile directly.
export {
  PROVIDER_CONFIGURED,
  providerConfigError,
  ARC,
  type ArcProfile,
  type ArcNetwork,
} from "@/lib/arcProfile";
