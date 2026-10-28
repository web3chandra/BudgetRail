/**
 * BudgetRail SDK — Public Types
 *
 * All USDC amounts are bigint in ERC-20 base units (6 decimals).
 * $1.00 = 1_000_000n, $0.05 = 50_000n.
 * Never pass floating-point values to these interfaces.
 */

// ── Chain / contract config ────────────────────────────────────────────────

export interface BudgetRailConfig {
  /** Deployed BudgetRail contract address. */
  contractAddress: `0x${string}`;
  /** Chain ID where the contract is deployed (5042002 = Arc Testnet, 5042 = Arc Mainnet). */
  chainId: number;
  /** RPC URL for read-only calls. */
  rpcUrl: string;
  /** Provider API base URL (no trailing slash, no /api suffix). */
  providerApiUrl: string;
  /** Provider payout wallet address C — must match onchain session.provider. */
  providerPayout: `0x${string}`;
  /** Provider quote signer public address D — must match onchain session.quoteSigner. */
  quoteSigner: `0x${string}`;
}

// ── Session ────────────────────────────────────────────────────────────────

export interface Session {
  id: bigint;
  owner: `0x${string}`;
  /** Authorized agent wallet B — only this address may call payForRequest. */
  agent: `0x${string}`;
  /** Provider payout wallet C. Immutable after creation. */
  provider: `0x${string}`;
  /** Quote signer address D. Immutable after creation. */
  quoteSigner: `0x${string}`;
  /** Maximum lifetime USDC budget (base units). Immutable. */
  maxBudget: bigint;
  /** Maximum USDC per single payForRequest call (base units). Immutable. */
  perPaymentCap: bigint;
  /** Cumulative USDC deposited (totalFunded ≤ maxBudget). */
  totalFunded: bigint;
  /** Cumulative USDC paid to provider. */
  totalSpent: bigint;
  /** Unix expiry timestamp. Agent cannot pay after this. */
  expiresAt: bigint;
  /** True once closeSession has been called. Irreversible. */
  closed: boolean;
  /** Computed: totalFunded − totalSpent. */
  availableBalance: bigint;
  /** Computed: maxBudget − totalFunded (remaining top-up room). */
  topUpHeadroom: bigint;
}

// ── Quote ──────────────────────────────────────────────────────────────────

export interface SignedQuote {
  sessionId: bigint;
  requestId: `0x${string}`;
  requestHash: `0x${string}`;
  amount: bigint;
  quoteDeadline: bigint;
  signature: `0x${string}`;
  chainId: number;
  contractAddress: `0x${string}`;
  providerPayout: `0x${string}`;
  quoteSignerAddress: `0x${string}`;
  service: string;
  displayPrice: string;
}

// ── Signer interface (injected — SDK never holds private keys) ─────────────

/** Minimal viem-compatible signer interface. */
export interface BudgetRailSigner {
  /** The wallet address this signer controls. */
  address: `0x${string}`;
  /**
   * Sign and broadcast a contract write, returning the transaction hash.
   * SDK calls this for fundSession, payForRequest, and closeSession.
   */
  writeContract(params: WriteContractParams): Promise<`0x${string}`>;
  /** Wait for a transaction receipt. */
  waitForReceipt(txHash: `0x${string}`): Promise<TransactionReceipt>;
}

export interface WriteContractParams {
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
  chainId: number;
}

export interface TransactionReceipt {
  status: "success" | "reverted";
  transactionHash: `0x${string}`;
  blockNumber: bigint;
  gasUsed: bigint;
  logs: readonly RawLog[];
}

export interface RawLog {
  address: `0x${string}`;
  topics: readonly `0x${string}`[];
  data: `0x${string}`;
}

// ── Payment result ─────────────────────────────────────────────────────────

export interface PaymentResult {
  txHash: `0x${string}`;
  receipt: TransactionReceipt;
  settledEvent: PaymentSettledEvent;
}

export interface PaymentSettledEvent {
  sessionId: bigint;
  requestId: `0x${string}`;
  provider: `0x${string}`;
  requestHash: `0x${string}`;
  agent: `0x${string}`;
  amount: bigint;
  quoteDeadline: bigint;
}

// ── Fund / refund ──────────────────────────────────────────────────────────

export interface AddFundsResult {
  approveTxHash: `0x${string}` | null; // null when allowance was already sufficient
  fundTxHash: `0x${string}`;
  totalFundedAfter: bigint;
  availableAfter: bigint;
}

export interface CloseAndRefundResult {
  txHash: `0x${string}`;
  refunded: bigint;
  totalSpent: bigint;
}

// ── Errors ─────────────────────────────────────────────────────────────────

export type BudgetRailErrorCode =
  | "SESSION_NOT_FOUND"
  | "NOT_OWNER"
  | "NOT_AGENT"
  | "SESSION_CLOSED"
  | "SESSION_EXPIRED"
  | "BUDGET_EXCEEDED"
  | "PER_PAYMENT_CAP_EXCEEDED"
  | "QUOTE_EXPIRED"
  | "DUPLICATE_REQUEST"
  | "INVALID_SIGNATURE"
  | "ZERO_ADDRESS"
  | "WRONG_CHAIN"
  | "PROVIDER_MISMATCH"
  | "SIGNER_MISMATCH"
  | "PROVIDER_UNREACHABLE"
  | "FULFILLMENT_FAILED"
  | "PAYMENT_NOT_SETTLED"
  | "SIMULATION_FAILED"
  | "UNKNOWN";

export class BudgetRailError extends Error {
  constructor(
    public readonly code: BudgetRailErrorCode,
    message: string,
    public readonly retryable: boolean = false,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BudgetRailError";
  }
}

// ── Scan coverage ────────────────────────────────────────────────────────────

export interface FailedRange {
  fromBlock: bigint;
  toBlock:   bigint;
  error:     string;
}

/**
 * Returned alongside scan results to describe coverage completeness.
 * isComplete is only true when ALL windows succeeded and fromBlock ≤ deployBlock.
 * Never treat partial results as complete when isComplete is false.
 */
export interface CoverageMetadata {
  scannedFrom:  bigint;
  scannedTo:    bigint;
  chainHead:    bigint;
  isComplete:   boolean;
  failedRanges: FailedRange[];
}

/**
 * Thrown by scanPaymentSettledEvents when one or more block windows fail after
 * retries. partialResults contains events decoded before the failure; coverage
 * contains the full failure map. Callers MUST check this error and warn the user.
 */
export class IncompleteHistoryError extends Error {
  constructor(
    message: string,
    public readonly partialResults: import("./read.js").ScannedPayment[],
    public readonly coverage: CoverageMetadata,
  ) {
    super(message);
    this.name = "IncompleteHistoryError";
  }
}

// ── V2 config extension ───────────────────────────────────────────────────

/**
 * V2-aware config. Extends V1 config with the V2 contract address and
 * treasury address. deployBlock is required for history scans.
 */
export interface BudgetRailV2Config extends BudgetRailConfig {
  /** Deployed BudgetRailV2 contract address. */
  v2ContractAddress: `0x${string}`;
  /** Treasury address E (immutable in V2 contract). */
  treasuryAddress: `0x${string}`;
  /** Block at which V2 was deployed (required for full-history scans). */
  v2DeployBlock: bigint;
}

// ── V2 price object ────────────────────────────────────────────────────────

/**
 * Transparent V2 fee breakdown. All amounts are bigint base units (6 decimals).
 * feeUnits = floor(baseUnits * 50 / 10_000).
 * grossUnits = baseUnits + feeUnits.
 * Cap checks MUST use grossUnits.
 */
export interface V2FeePrice {
  /** Provider quoted price; provider C receives this. */
  baseUnits: bigint;
  /** Platform fee 50 bps; treasury E receives this. */
  feeUnits: bigint;
  /** Total session debit = baseUnits + feeUnits. Cap checks use this. */
  grossUnits: bigint;
  /** Always 50 for V2. */
  feeBps: number;
  /** Human-readable: "$0.050000 + $0.000250 fee = $0.050250 gross" */
  displayBreakdown: string;
}

/** Compute exact V2 fee. Matches Solidity: floor(base * 50 / 10_000). */
export function computeV2Fee(baseUnits: bigint): V2FeePrice {
  const FEE_BPS = 50n;
  const DENOM   = 10_000n;
  const feeUnits   = (baseUnits * FEE_BPS) / DENOM;
  const grossUnits = baseUnits + feeUnits;
  const fmt = (u: bigint) => `$${(Number(u) / 1e6).toFixed(6)}`;
  return {
    baseUnits,
    feeUnits,
    grossUnits,
    feeBps: 50,
    displayBreakdown: `${fmt(baseUnits)} + ${fmt(feeUnits)} fee = ${fmt(grossUnits)} gross`,
  };
}

// ── V2 signed quote ────────────────────────────────────────────────────────

/** V2 quote includes the full fee breakdown in the signed message. */
export interface SignedQuoteV2 {
  version: "2";
  sessionId: bigint;
  requestId: `0x${string}`;
  /** SHA-256(input) — included in EIP-712 signed struct (P0 fix). */
  requestHash: `0x${string}`;
  /** Provider base price (C receives this). */
  baseAmount: bigint;
  /** Platform fee (E receives this). floor(base * 50 / 10_000). */
  feeAmount: bigint;
  /** Gross = base + fee. Session is debited this amount. */
  grossAmount: bigint;
  /** Quote expiry unix timestamp. Field name matches contract payForRequestV2 param. */
  deadline: bigint;
  signature: `0x${string}`;
  chainId: number;
  contractAddress: `0x${string}`;
  providerPayout: `0x${string}`;
  treasuryAddress: `0x${string}`;
  quoteSignerAddress: `0x${string}`;
  service: string;
  displayBreakdown: string;
}

// ── V2 payment event ───────────────────────────────────────────────────────

export interface PaymentSettledV2Event {
  sessionId: bigint;
  requestId: `0x${string}`;
  agent: `0x${string}`;
  /** SHA-256(input) — P0 fix: now onchain and verified. */
  requestHash: `0x${string}`;
  provider: `0x${string}`;
  treasury: `0x${string}`;
  baseAmount: bigint;
  feeAmount: bigint;
  grossAmount: bigint;
  remainingBalance: bigint;
}

export interface PaymentResultV2 {
  txHash: `0x${string}`;
  receipt: TransactionReceipt;
  settledEvent: PaymentSettledV2Event;
  feeBreakdown: V2FeePrice;
}

// ── Provider health ───────────────────────────────────────────────────────

export interface ProviderHealth {
  status: "ok" | "degraded";
  chainId: number;
  contractAddress: `0x${string}`;
  providerPayout: `0x${string}`;
  quoteSignerAddress: `0x${string}`;
  serviceName: string;
  pricePerCall: string;
  rpcOk: boolean;
}

// ── Service registry ──────────────────────────────────────────────────────

export interface ServiceDescriptor {
  /** Machine identifier, used in quote/fulfill requests. */
  id: string;
  /** Display name. */
  name: string;
  /** Short description. */
  description: string;
  /** Fixed price in USDC display string (e.g. "$0.05"). */
  displayPrice: string;
  /** Price in base units. */
  priceUnits: bigint;
  /** Input schema hint. */
  inputType: "text" | "github_repo";
  /** Input byte limit. */
  maxInputBytes: number;
}
