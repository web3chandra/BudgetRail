/**
 * Onchain read helpers — public client for Arc Testnet/Mainnet.
 * Never signs or broadcasts transactions; read-only.
 */

import { createPublicClient, http, parseAbi, decodeEventLog, type Log, type TransactionReceipt } from "viem";
import { type Config } from "./config.js";

// ── ABI fragments ──────────────────────────────────────────────────────────

export const BUDGET_RAIL_ABI = parseAbi([
  // Read functions
  "function getSession(uint256 sessionId) view returns ((address owner,address agent,address provider,address quoteSigner,uint96 maxBudget,uint96 perPaymentCap,uint96 totalFunded,uint96 totalSpent,uint64 expiresAt,bool closed))",
  "function availableBalance(uint256 sessionId) view returns (uint96)",
  // Events
  "event PaymentSettled(uint256 indexed sessionId,bytes32 indexed requestId,address indexed provider,bytes32 requestHash,address agent,uint96 amount,uint64 quoteDeadline)",
  "event SessionCreated(uint256 indexed sessionId,address indexed owner,address indexed agent,address provider,address quoteSigner,uint96 maxBudget,uint96 perPaymentCap,uint64 expiresAt)",
  "event SessionFunded(uint256 indexed sessionId,address indexed owner,uint96 amount,uint96 totalFunded)",
  "event SessionClosed(uint256 indexed sessionId,address indexed owner,uint96 refunded,uint96 totalSpent)",
]);

export const ERC20_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);

// ── Session type (mirrors BudgetRail.sol struct) ───────────────────────────

export interface Session {
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
}

// ── Client factory (one per request to keep it stateless) ─────────────────

export function makeClient(config: Config) {
  return createPublicClient({
    transport: http(config.rpcUrl, { timeout: 10_000 }),
  });
}

// ── Read session ──────────────────────────────────────────────────────────

export async function readSession(config: Config, sessionId: bigint): Promise<Session | null> {
  const client = makeClient(config);
  try {
    const result = await client.readContract({
      address: config.contractAddress,
      abi: BUDGET_RAIL_ABI,
      functionName: "getSession",
      args: [sessionId],
    }) as unknown as Session;
    // Zero owner means session does not exist
    if (result.owner === "0x0000000000000000000000000000000000000000") return null;
    return result;
  } catch {
    return null;
  }
}

// ── Fetch transaction receipt ──────────────────────────────────────────────

export async function fetchReceipt(
  config: Config,
  txHash: `0x${string}`,
): Promise<TransactionReceipt | null> {
  const client = makeClient(config);
  try {
    return await client.getTransactionReceipt({ hash: txHash });
  } catch {
    return null;
  }
}

// ── Fetch transaction (to get tx.from == agent) ────────────────────────────

export async function fetchTransaction(config: Config, txHash: `0x${string}`) {
  const client = makeClient(config);
  try {
    return await client.getTransaction({ hash: txHash });
  } catch {
    return null;
  }
}

// ── Decode PaymentSettled log ─────────────────────────────────────────────

export interface DecodedPaymentSettled {
  sessionId:     bigint;
  requestId:     `0x${string}`;
  provider:      `0x${string}`;
  requestHash:   `0x${string}`;
  agent:         `0x${string}`;
  amount:        bigint;
  quoteDeadline: bigint;
}

export function decodePaymentSettledLog(log: Log): DecodedPaymentSettled | null {
  try {
    const decoded = decodeEventLog({
      abi: BUDGET_RAIL_ABI,
      eventName: "PaymentSettled",
      data:   log.data,
      topics: log.topics,
    });
    const args = decoded.args as {
      sessionId: bigint; requestId: `0x${string}`; provider: `0x${string}`;
      requestHash: `0x${string}`; agent: `0x${string}`; amount: bigint; quoteDeadline: bigint;
    };
    return {
      sessionId:     args.sessionId,
      requestId:     args.requestId.toLowerCase() as `0x${string}`,
      provider:      args.provider.toLowerCase() as `0x${string}`,
      requestHash:   args.requestHash.toLowerCase() as `0x${string}`,
      agent:         args.agent.toLowerCase() as `0x${string}`,
      amount:        args.amount,
      quoteDeadline: args.quoteDeadline,
    };
  } catch {
    return null;
  }
}

// ── Decode ERC-20 Transfer log ────────────────────────────────────────────

export interface DecodedTransfer {
  from:  `0x${string}`;
  to:    `0x${string}`;
  value: bigint;
}

export function decodeTransferLog(log: Log): DecodedTransfer | null {
  try {
    const decoded = decodeEventLog({
      abi: ERC20_ABI,
      eventName: "Transfer",
      data:   log.data,
      topics: log.topics,
    });
    const args = decoded.args as { from: `0x${string}`; to: `0x${string}`; value: bigint };
    return {
      from:  args.from.toLowerCase()  as `0x${string}`,
      to:    args.to.toLowerCase()    as `0x${string}`,
      value: args.value,
    };
  } catch {
    return null;
  }
}

// ── Extract block timestamp from receipt's block ───────────────────────────

export async function fetchBlockTimestamp(config: Config, blockNumber: bigint): Promise<bigint | null> {
  const client = makeClient(config);
  try {
    const block = await client.getBlock({ blockNumber });
    return block.timestamp;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// V2 ABI and decode helpers
// IMPORTANT: V1 and V2 ABIs are intentionally separate.
// NEVER merge them or use V1 decoders on V2 logs (or vice versa).
// The event signatures differ (PaymentSettled vs PaymentSettledV2) so
// their topic0 hashes are structurally distinct — cross-decode will throw.
// ═══════════════════════════════════════════════════════════════════════════

export const BUDGET_RAIL_V2_ABI = parseAbi([
  // Functions
  "function getSession(uint256 sessionId) view returns ((address owner,address agent,address provider,address quoteSigner,uint256 maxBudget,uint256 perPaymentCap,uint256 totalFunded,uint256 totalSpent,uint64 expiresAt,bool closed))",
  "function availableBalance(uint256 sessionId) view returns (uint256)",
  "function computeFee(uint256 baseAmount) view returns (uint256 feeAmount, uint256 grossAmount)",
  "function TREASURY() view returns (address)",
  "function FEE_BPS() view returns (uint256)",
  "function USDC_ADDRESS() view returns (address)",
  // V2 Events — distinct from V1; do NOT use V1 decoder on these logs
  "event PaymentSettledV2(uint256 indexed sessionId,bytes32 indexed requestId,address indexed agent,address provider,address treasury,uint256 baseAmount,uint256 feeAmount,uint256 grossAmount,uint256 remainingBalance)",
  "event SessionCreated(uint256 indexed sessionId,address indexed owner,address indexed agent,address provider,address quoteSigner,uint256 maxBudget,uint256 perPaymentCap,uint64 expiresAt)",
  "event SessionFunded(uint256 indexed sessionId,address indexed funder,uint256 grossAmount,uint256 totalFunded)",
  "event SessionClosed(uint256 indexed sessionId,address indexed owner,uint256 refundAmount,uint256 totalSpent)",
]);

/** Session struct from V2 contract — uses uint256 for all amounts. */
export interface SessionV2 {
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
}

/** Read a V2 session from chain. Returns null if session does not exist or RPC fails. */
export async function readSessionV2(
  config: Config,
  v2ContractAddress: `0x${string}`,
  sessionId: bigint,
): Promise<SessionV2 | null> {
  const client = makeClient(config);
  try {
    const result = await client.readContract({
      address: v2ContractAddress,
      abi:     BUDGET_RAIL_V2_ABI,
      functionName: "getSession",
      args:    [sessionId],
    }) as unknown as SessionV2;
    if (result.owner === "0x0000000000000000000000000000000000000000") return null;
    return result;
  } catch {
    return null;
  }
}

/**
 * Read the TREASURY immutable from the V2 contract and compare to expected.
 * Returns the onchain treasury address, or throws if the call fails.
 * Used at startup to fail-closed on treasury mismatch.
 */
export async function readV2Treasury(
  config: Config,
  v2ContractAddress: `0x${string}`,
): Promise<`0x${string}`> {
  const client = makeClient(config);
  const addr = await client.readContract({
    address:      v2ContractAddress,
    abi:          BUDGET_RAIL_V2_ABI,
    functionName: "TREASURY",
    args:         [],
  }) as `0x${string}`;
  return addr.toLowerCase() as `0x${string}`;
}

/** Decoded PaymentSettledV2 event fields. */
export interface DecodedPaymentSettledV2 {
  sessionId:        bigint;
  requestId:        `0x${string}`;
  agent:            `0x${string}`;
  provider:         `0x${string}`;
  treasury:         `0x${string}`;
  baseAmount:       bigint;
  feeAmount:        bigint;
  grossAmount:      bigint;
  remainingBalance: bigint;
}

/** Decode a PaymentSettledV2 log using the V2 ABI. Returns null on failure. */
export function decodePaymentSettledV2Log(log: Log): DecodedPaymentSettledV2 | null {
  try {
    const decoded = decodeEventLog({
      abi:       BUDGET_RAIL_V2_ABI,
      eventName: "PaymentSettledV2",
      data:      log.data,
      topics:    log.topics,
    });
    const args = decoded.args as {
      sessionId: bigint; requestId: `0x${string}`; agent: `0x${string}`;
      provider: `0x${string}`; treasury: `0x${string}`;
      baseAmount: bigint; feeAmount: bigint; grossAmount: bigint; remainingBalance: bigint;
    };
    return {
      sessionId:        args.sessionId,
      requestId:        args.requestId.toLowerCase() as `0x${string}`,
      agent:            args.agent.toLowerCase() as `0x${string}`,
      provider:         args.provider.toLowerCase() as `0x${string}`,
      treasury:         args.treasury.toLowerCase() as `0x${string}`,
      baseAmount:       args.baseAmount,
      feeAmount:        args.feeAmount,
      grossAmount:      args.grossAmount,
      remainingBalance: args.remainingBalance,
    };
  } catch {
    return null;
  }
}
