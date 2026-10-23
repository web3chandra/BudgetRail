/**
 * BudgetRail ABI — single source of truth shared by SDK and frontend.
 * Extracted from the deployed contract on Arc Testnet.
 * Contract address: 0xf6a13df15ad93c2e2968e1d69c53894a923bda21
 */

export const BUDGET_RAIL_ABI = [
  // ── Read functions ──────────────────────────────────────────────────────
  {
    type: "function", name: "getSession",
    inputs:  [{ name: "sessionId", type: "uint256" }],
    outputs: [{ name: "", type: "tuple", components: [
      { name: "owner",         type: "address" },
      { name: "agent",         type: "address" },
      { name: "provider",      type: "address" },
      { name: "quoteSigner",   type: "address" },
      { name: "maxBudget",     type: "uint96"  },
      { name: "perPaymentCap", type: "uint96"  },
      { name: "totalFunded",   type: "uint96"  },
      { name: "totalSpent",    type: "uint96"  },
      { name: "expiresAt",     type: "uint64"  },
      { name: "closed",        type: "bool"    },
    ]}],
    stateMutability: "view",
  },
  {
    type: "function", name: "availableBalance",
    inputs:  [{ name: "sessionId", type: "uint256" }],
    outputs: [{ name: "", type: "uint96" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "ownerSessionCount",
    inputs:  [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "sessionIdsByOwner",
    inputs:  [
      { name: "owner",  type: "address" },
      { name: "offset", type: "uint256" },
      { name: "limit",  type: "uint256" },
    ],
    outputs: [{ name: "ids", type: "uint256[]" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "USDC_ADDRESS",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  // ── Write functions ─────────────────────────────────────────────────────
  {
    type: "function", name: "createSession",
    inputs: [
      { name: "agent",         type: "address" },
      { name: "provider",      type: "address" },
      { name: "quoteSigner",   type: "address" },
      { name: "maxBudget",     type: "uint96"  },
      { name: "perPaymentCap", type: "uint96"  },
      { name: "expiresAt",     type: "uint64"  },
    ],
    outputs: [{ name: "sessionId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "fundSession",
    inputs: [
      { name: "sessionId", type: "uint256" },
      { name: "amount",    type: "uint96"  },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "payForRequest",
    inputs: [
      { name: "sessionId",         type: "uint256" },
      { name: "requestId",         type: "bytes32" },
      { name: "requestHash",       type: "bytes32" },
      { name: "amount",            type: "uint96"  },
      { name: "quoteDeadline",     type: "uint64"  },
      { name: "providerSignature", type: "bytes"   },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "closeSession",
    inputs: [{ name: "sessionId", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // ── Custom errors ───────────────────────────────────────────────────────
  { type: "error", name: "ZeroAddress",                inputs: [] },
  { type: "error", name: "InvalidBudget",              inputs: [] },
  { type: "error", name: "InvalidPerPaymentCap",       inputs: [] },
  { type: "error", name: "ExpiryInPast",               inputs: [] },
  { type: "error", name: "SessionNotFound",            inputs: [] },
  { type: "error", name: "NotOwner",                   inputs: [] },
  { type: "error", name: "NotAgent",                   inputs: [] },
  { type: "error", name: "SessionAlreadyClosed",       inputs: [] },
  { type: "error", name: "SessionExpired",             inputs: [] },
  { type: "error", name: "ZeroAmount",                 inputs: [] },
  { type: "error", name: "BudgetExceeded",             inputs: [] },
  { type: "error", name: "FundedBudgetExceeded",       inputs: [] },
  { type: "error", name: "LifetimeBudgetExceeded",     inputs: [] },
  { type: "error", name: "PerPaymentCapExceeded",      inputs: [] },
  { type: "error", name: "QuoteExpired",               inputs: [] },
  { type: "error", name: "QuoteDeadlineExceedsSession",inputs: [] },
  { type: "error", name: "RequestAlreadyPaid",         inputs: [] },
  { type: "error", name: "InvalidSignature",           inputs: [] },
  { type: "error", name: "InvalidOffset",              inputs: [] },
  // ── Events ──────────────────────────────────────────────────────────────
  {
    type: "event", name: "SessionCreated",
    inputs: [
      { name: "sessionId",    type: "uint256", indexed: true  },
      { name: "owner",        type: "address", indexed: true  },
      { name: "agent",        type: "address", indexed: true  },
      { name: "provider",     type: "address", indexed: false },
      { name: "quoteSigner",  type: "address", indexed: false },
      { name: "maxBudget",    type: "uint96",  indexed: false },
      { name: "perPaymentCap",type: "uint96",  indexed: false },
      { name: "expiresAt",    type: "uint64",  indexed: false },
    ],
  },
  {
    type: "event", name: "SessionFunded",
    inputs: [
      { name: "sessionId",   type: "uint256", indexed: true  },
      { name: "owner",       type: "address", indexed: true  },
      { name: "amount",      type: "uint96",  indexed: false },
      { name: "totalFunded", type: "uint96",  indexed: false },
    ],
  },
  {
    type: "event", name: "PaymentSettled",
    inputs: [
      { name: "sessionId",    type: "uint256", indexed: true  },
      { name: "requestId",    type: "bytes32", indexed: true  },
      { name: "provider",     type: "address", indexed: true  },
      { name: "requestHash",  type: "bytes32", indexed: false },
      { name: "agent",        type: "address", indexed: false },
      { name: "amount",       type: "uint96",  indexed: false },
      { name: "quoteDeadline",type: "uint64",  indexed: false },
    ],
  },
  {
    type: "event", name: "SessionClosed",
    inputs: [
      { name: "sessionId",  type: "uint256", indexed: true  },
      { name: "owner",      type: "address", indexed: true  },
      { name: "refunded",   type: "uint96",  indexed: false },
      { name: "totalSpent", type: "uint96",  indexed: false },
    ],
  },
] as const;

export const ERC20_ABI = [
  {
    type: "function", name: "allowance",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "approve",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "event", name: "Transfer",
    inputs: [
      { name: "from",  type: "address", indexed: true  },
      { name: "to",    type: "address", indexed: true  },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

// ── Canonical deploy facts ──────────────────────────────────────────────────

export const ARC_TESTNET_CONTRACT = "0xf6a13df15ad93c2e2968e1d69c53894a923bda21" as const;
export const ARC_TESTNET_CHAIN_ID = 5042002 as const;
export const ARC_MAINNET_CHAIN_ID = 5042 as const;
export const USDC_ADDRESS         = "0x3600000000000000000000000000000000000000" as const;
export const USDC_DECIMALS        = 6 as const;

/** Block at which BudgetRail V1 was deployed on Arc Testnet. */
export const DEPLOY_BLOCK_TESTNET = 67538363n;

// ── BudgetRailV2 ABI ─────────────────────────────────────────────────────────

export const BUDGET_RAIL_V2_ABI = [
  // ── Read ──────────────────────────────────────────────────────────────────
  {
    type: "function", name: "getSession",
    inputs:  [{ name: "sessionId", type: "uint256" }],
    outputs: [{ name: "", type: "tuple", components: [
      { name: "owner",         type: "address" },
      { name: "agent",         type: "address" },
      { name: "provider",      type: "address" },
      { name: "quoteSigner",   type: "address" },
      { name: "maxBudget",     type: "uint96"  },
      { name: "perPaymentCap", type: "uint96"  },
      { name: "totalFunded",   type: "uint96"  },
      { name: "totalSpent",    type: "uint96"  },
      { name: "expiresAt",     type: "uint64"  },
      { name: "closed",        type: "bool"    },
    ]}],
    stateMutability: "view",
  },
  {
    type: "function", name: "availableBalance",
    inputs:  [{ name: "sessionId", type: "uint256" }],
    outputs: [{ name: "", type: "uint96" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "sessionIdsByOwner",
    inputs: [
      { name: "owner",  type: "address" },
      { name: "offset", type: "uint256" },
      { name: "limit",  type: "uint256" },
    ],
    outputs: [{ name: "ids", type: "uint256[]" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "TREASURY",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "FEE_BPS",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "computeFee",
    inputs: [{ name: "baseAmount", type: "uint256" }],
    outputs: [{ name: "feeAmount", type: "uint256" }],
    stateMutability: "view",
  },
  // ── Write ─────────────────────────────────────────────────────────────────
  {
    type: "function", name: "createSession",
    inputs: [
      { name: "agent",         type: "address" },
      { name: "provider",      type: "address" },
      { name: "quoteSigner",   type: "address" },
      { name: "maxBudget",     type: "uint96"  },
      { name: "perPaymentCap", type: "uint96"  },
      { name: "expiresAt",     type: "uint64"  },
    ],
    outputs: [{ name: "sessionId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "fundSession",
    inputs: [
      { name: "sessionId", type: "uint256" },
      { name: "amount",    type: "uint96"  },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "payForRequestV2",
    inputs: [
      { name: "sessionId",         type: "uint256" },
      { name: "requestId",         type: "bytes32" },
      { name: "requestHash",       type: "bytes32" },
      { name: "baseAmount",        type: "uint96"  },
      { name: "feeAmount",         type: "uint96"  },
      { name: "quoteDeadline",     type: "uint64"  },
      { name: "providerSignature", type: "bytes"   },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "closeSession",
    inputs: [{ name: "sessionId", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // ── Errors ─────────────────────────────────────────────────────────────────
  { type: "error", name: "ZeroAddress",                inputs: [] },
  { type: "error", name: "InvalidBudget",              inputs: [] },
  { type: "error", name: "InvalidPerPaymentCap",       inputs: [] },
  { type: "error", name: "ExpiryInPast",               inputs: [] },
  { type: "error", name: "SessionNotFound",            inputs: [] },
  { type: "error", name: "NotOwner",                   inputs: [] },
  { type: "error", name: "NotAgent",                   inputs: [] },
  { type: "error", name: "SessionAlreadyClosed",       inputs: [] },
  { type: "error", name: "SessionExpired",             inputs: [] },
  { type: "error", name: "ZeroAmount",                 inputs: [] },
  { type: "error", name: "FundedBudgetExceeded",       inputs: [] },
  { type: "error", name: "LifetimeBudgetExceeded",     inputs: [] },
  { type: "error", name: "PerPaymentCapExceeded",      inputs: [] },
  { type: "error", name: "QuoteExpired",               inputs: [] },
  { type: "error", name: "InvalidFeeAmount",           inputs: [] },
  { type: "error", name: "RequestAlreadyPaid",         inputs: [] },
  { type: "error", name: "InvalidSignature",           inputs: [] },
  { type: "error", name: "TreasuryTransferFailed",     inputs: [] },
  // ── Events ─────────────────────────────────────────────────────────────────
  {
    type: "event", name: "PaymentSettledV2",
    inputs: [
      { name: "sessionId",    type: "uint256", indexed: true  },
      { name: "requestId",    type: "bytes32", indexed: true  },
      { name: "provider",     type: "address", indexed: true  },
      { name: "treasury",     type: "address", indexed: false },
      { name: "requestHash",  type: "bytes32", indexed: false },
      { name: "agent",        type: "address", indexed: false },
      { name: "baseAmount",   type: "uint96",  indexed: false },
      { name: "feeAmount",    type: "uint96",  indexed: false },
      { name: "grossAmount",  type: "uint96",  indexed: false },
      { name: "quoteDeadline",type: "uint64",  indexed: false },
    ],
  },
  {
    type: "event", name: "SessionCreated",
    inputs: [
      { name: "sessionId",    type: "uint256", indexed: true  },
      { name: "owner",        type: "address", indexed: true  },
      { name: "agent",        type: "address", indexed: true  },
      { name: "provider",     type: "address", indexed: false },
      { name: "quoteSigner",  type: "address", indexed: false },
      { name: "maxBudget",    type: "uint96",  indexed: false },
      { name: "perPaymentCap",type: "uint96",  indexed: false },
      { name: "expiresAt",    type: "uint64",  indexed: false },
    ],
  },
  {
    type: "event", name: "SessionFunded",
    inputs: [
      { name: "sessionId",   type: "uint256", indexed: true  },
      { name: "owner",       type: "address", indexed: true  },
      { name: "amount",      type: "uint96",  indexed: false },
      { name: "totalFunded", type: "uint96",  indexed: false },
    ],
  },
  {
    type: "event", name: "SessionClosed",
    inputs: [
      { name: "sessionId",  type: "uint256", indexed: true  },
      { name: "owner",      type: "address", indexed: true  },
      { name: "refunded",   type: "uint96",  indexed: false },
      { name: "totalSpent", type: "uint96",  indexed: false },
    ],
  },
] as const;

/** V2 fee constants — match the contract exactly. */
export const V2_FEE_BPS  = 50n;
export const V2_FEE_DENOM = 10_000n;
