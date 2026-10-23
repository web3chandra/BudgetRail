/**
 * BudgetRail SDK — Read operations (no signing, no private keys).
 *
 * All functions accept a viem PublicClient-compatible object or a raw RPC URL.
 */

import { createPublicClient, http, decodeEventLog, type Log } from "viem";
import { BUDGET_RAIL_ABI, BUDGET_RAIL_V2_ABI, DEPLOY_BLOCK_TESTNET } from "./abi.js";
import { BudgetRailError, IncompleteHistoryError } from "./types.js";
import type {
  BudgetRailConfig, BudgetRailV2Config, Session,
  PaymentSettledEvent, PaymentSettledV2Event,
  CoverageMetadata, FailedRange,
} from "./types.js";

/** Backoff base for window retries (ms). */
const SDK_BACKOFF_MS  = 800;
/** Max retry attempts per window before recording a failure. */
const SDK_MAX_RETRIES = 3;

// ── Internal viem client ──────────────────────────────────────────────────

function makeClient(config: Pick<BudgetRailConfig, "rpcUrl" | "chainId">) {
  return createPublicClient({
    transport: http(config.rpcUrl, { timeout: 15_000 }),
  });
}

// ── readSession ────────────────────────────────────────────────────────────

/**
 * Fetch a single session by ID.
 * Returns null when the session does not exist (owner == zero address).
 * Throws BudgetRailError on RPC failure.
 */
export async function readSession(
  config: BudgetRailConfig,
  sessionId: bigint,
): Promise<Session | null> {
  const client = makeClient(config);
  try {
    const raw = await client.readContract({
      address: config.contractAddress,
      abi: BUDGET_RAIL_ABI,
      functionName: "getSession",
      args: [sessionId],
    }) as {
      owner: `0x${string}`; agent: `0x${string}`; provider: `0x${string}`;
      quoteSigner: `0x${string}`; maxBudget: bigint; perPaymentCap: bigint;
      totalFunded: bigint; totalSpent: bigint; expiresAt: bigint; closed: boolean;
    };
    if (raw.owner === "0x0000000000000000000000000000000000000000") return null;
    const availableBalance = raw.totalFunded > raw.totalSpent
      ? raw.totalFunded - raw.totalSpent
      : 0n;
    const topUpHeadroom = raw.maxBudget > raw.totalFunded
      ? raw.maxBudget - raw.totalFunded
      : 0n;
    return {
      id: sessionId,
      owner:          raw.owner.toLowerCase()       as `0x${string}`,
      agent:          raw.agent.toLowerCase()       as `0x${string}`,
      provider:       raw.provider.toLowerCase()    as `0x${string}`,
      quoteSigner:    raw.quoteSigner.toLowerCase() as `0x${string}`,
      maxBudget:      raw.maxBudget,
      perPaymentCap:  raw.perPaymentCap,
      totalFunded:    raw.totalFunded,
      totalSpent:     raw.totalSpent,
      expiresAt:      raw.expiresAt,
      closed:         raw.closed,
      availableBalance,
      topUpHeadroom,
    };
  } catch (err) {
    throw new BudgetRailError("SESSION_NOT_FOUND", `Failed to read session ${sessionId}: ${(err as Error).message}`, true, err);
  }
}

// ── listOwnerSessions ──────────────────────────────────────────────────────

/**
 * List all sessions owned by a given address.
 * Uses sessionIdsByOwner with offset/limit pagination.
 * Returns sessions in ID order with their full data.
 */
export async function listOwnerSessions(
  config: BudgetRailConfig,
  owner: `0x${string}`,
  opts?: { offset?: bigint; limit?: bigint },
): Promise<Session[]> {
  const client = makeClient(config);
  const offset = opts?.offset ?? 0n;
  const limit  = opts?.limit  ?? 50n;

  let ids: bigint[];
  try {
    ids = (await client.readContract({
      address: config.contractAddress,
      abi: BUDGET_RAIL_ABI,
      functionName: "sessionIdsByOwner",
      args: [owner, offset, limit],
    })) as bigint[];
  } catch (err) {
    throw new BudgetRailError("SESSION_NOT_FOUND", `Failed to list sessions for ${owner}: ${(err as Error).message}`, true, err);
  }

  // Fetch all session data in parallel
  const sessions = await Promise.all(ids.map((id) => readSession(config, id)));
  return sessions.filter((s): s is Session => s !== null);
}

// ── getSpendableBalance ────────────────────────────────────────────────────

/**
 * Returns totalFunded − totalSpent for a session.
 * Uses the contract's availableBalance view (more gas-efficient for single reads).
 */
export async function getSpendableBalance(
  config: BudgetRailConfig,
  sessionId: bigint,
): Promise<bigint> {
  const client = makeClient(config);
  try {
    return (await client.readContract({
      address: config.contractAddress,
      abi: BUDGET_RAIL_ABI,
      functionName: "availableBalance",
      args: [sessionId],
    })) as bigint;
  } catch (err) {
    throw new BudgetRailError("SESSION_NOT_FOUND", `availableBalance(${sessionId}) failed: ${(err as Error).message}`, true, err);
  }
}

// ── verifyChain ────────────────────────────────────────────────────────────

/**
 * Verify the connected RPC is on the expected chain.
 * Throws WRONG_CHAIN if chainId does not match config.
 */
export async function verifyChain(config: BudgetRailConfig): Promise<void> {
  const client = makeClient(config);
  const chainId = await client.getChainId();
  if (chainId !== config.chainId) {
    throw new BudgetRailError(
      "WRONG_CHAIN",
      `Connected to chain ${chainId}, expected ${config.chainId}`,
    );
  }
}

// ── decodePaymentSettledLog ───────────────────────────────────────────────

/**
 * Decode a raw log into a PaymentSettledEvent.
 * Returns null when the log is not a PaymentSettled event.
 */
export function decodePaymentSettledLog(log: Log): PaymentSettledEvent | null {
  try {
    const decoded = decodeEventLog({
      abi: BUDGET_RAIL_ABI,
      eventName: "PaymentSettled",
      data: log.data,
      topics: log.topics,
    });
    const args = decoded.args as {
      sessionId: bigint; requestId: `0x${string}`; provider: `0x${string}`;
      requestHash: `0x${string}`; agent: `0x${string}`; amount: bigint; quoteDeadline: bigint;
    };
    return {
      sessionId:     args.sessionId,
      requestId:     args.requestId.toLowerCase()  as `0x${string}`,
      provider:      args.provider.toLowerCase()   as `0x${string}`,
      requestHash:   args.requestHash.toLowerCase() as `0x${string}`,
      agent:         args.agent.toLowerCase()      as `0x${string}`,
      amount:        args.amount,
      quoteDeadline: args.quoteDeadline,
    };
  } catch {
    return null;
  }
}

// ── scanPaymentSettledEvents ──────────────────────────────────────────────

export interface ScanOptions {
  /** Start scanning from this block. Defaults to DEPLOY_BLOCK_TESTNET. */
  fromBlock?: bigint;
  /** End block. Defaults to current head. */
  toBlock?: bigint;
  /** Filter to a specific sessionId (topic[1]). */
  sessionId?: bigint;
  /** Max block range per getLogs batch. Default 5000. */
  windowSize?: bigint;
}

export interface ScannedPayment extends PaymentSettledEvent {
  txHash: `0x${string}`;
  blockNumber: bigint;
}

/**
 * Scan for PaymentSettled events in bounded ranges.
 * Paginates automatically; returns de-duplicated results sorted by block.
 *
 * Changed from original:
 *  - Dedup key is now `${txHash}-${logIndex}` (not requestId alone).
 *  - Failed windows are recorded in CoverageMetadata.failedRanges and re-thrown
 *    as IncompleteHistoryError rather than silently swallowed.
 *  - Returns CoverageMetadata alongside results so callers know scan completeness.
 *  - Exponential backoff per window (up to MAX_RETRIES) before marking failed.
 */
export async function scanPaymentSettledEvents(
  config: BudgetRailConfig,
  opts?: ScanOptions,
): Promise<{ events: ScannedPayment[]; coverage: CoverageMetadata }> {
  const client     = makeClient(config);
  const windowSize = opts?.windowSize ?? 5000n;
  const fromBlock  = opts?.fromBlock  ?? DEPLOY_BLOCK_TESTNET;
  const head       = await client.getBlockNumber();
  const toBlock    = opts?.toBlock !== undefined && opts.toBlock < head ? opts.toBlock : head;

  const seen    = new Set<string>();
  const results: ScannedPayment[]  = [];
  const failed:  FailedRange[]     = [];

  for (let start = fromBlock; start <= toBlock; start += windowSize + 1n) {
    const end = start + windowSize > toBlock ? toBlock : start + windowSize;

    let attempt = 0;
    let lastErr  = "";
    let succeeded = false;

    while (attempt < SDK_MAX_RETRIES) {
      try {
        const logs = await client.getLogs({
          address:   config.contractAddress,
          fromBlock: start,
          toBlock:   end,
        });
        for (const log of logs) {
          const decoded = decodePaymentSettledLog(log as Log);
          if (!decoded) continue;
          // Dedup by txHash + logIndex, NOT by requestId alone
          const key = `${log.transactionHash ?? ""}-${log.logIndex ?? 0}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({
            ...decoded,
            txHash:      (log.transactionHash ?? "0x") as `0x${string}`,
            blockNumber: log.blockNumber ?? 0n,
          });
        }
        succeeded = true;
        break;
      } catch (e) {
        lastErr = (e as Error).message;
        attempt++;
        if (attempt < SDK_MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, SDK_BACKOFF_MS * Math.pow(2, attempt - 1)));
        }
      }
    }

    if (!succeeded) {
      failed.push({ fromBlock: start, toBlock: end, error: lastErr });
    }
  }

  const isComplete = failed.length === 0 && fromBlock <= DEPLOY_BLOCK_TESTNET;
  const coverage: CoverageMetadata = {
    scannedFrom:  fromBlock,
    scannedTo:    toBlock,
    chainHead:    head,
    isComplete,
    failedRanges: failed,
  };

  if (failed.length > 0) {
    throw new IncompleteHistoryError(
      `Scan incomplete: ${failed.length} window(s) failed after retries. ` +
      `Partial results (${results.length} events) available via error.partialResults.`,
      results,
      coverage,
    );
  }

  return {
    events:   results.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1)),
    coverage,
  };
}

// ── V2 read functions ──────────────────────────────────────────────────────

/**
 * Read a V2 session. Uses the V2 contract address from config.
 * Returns null when sessionId does not exist.
 */
export async function readSessionV2(
  config: BudgetRailV2Config,
  sessionId: bigint,
): Promise<Session | null> {
  const client = makeClient(config);
  try {
    const raw = await client.readContract({
      address: config.v2ContractAddress,
      abi:     BUDGET_RAIL_V2_ABI,
      functionName: "getSession",
      args: [sessionId],
    }) as {
      owner: `0x${string}`; agent: `0x${string}`; provider: `0x${string}`;
      quoteSigner: `0x${string}`; maxBudget: bigint; perPaymentCap: bigint;
      totalFunded: bigint; totalSpent: bigint; expiresAt: bigint; closed: boolean;
    };
    if (raw.owner === "0x0000000000000000000000000000000000000000") return null;
    return {
      id: sessionId,
      owner:          raw.owner.toLowerCase()       as `0x${string}`,
      agent:          raw.agent.toLowerCase()       as `0x${string}`,
      provider:       raw.provider.toLowerCase()    as `0x${string}`,
      quoteSigner:    raw.quoteSigner.toLowerCase() as `0x${string}`,
      maxBudget:      raw.maxBudget,
      perPaymentCap:  raw.perPaymentCap,
      totalFunded:    raw.totalFunded,
      totalSpent:     raw.totalSpent,
      expiresAt:      raw.expiresAt,
      closed:         raw.closed,
      availableBalance: raw.totalFunded > raw.totalSpent ? raw.totalFunded - raw.totalSpent : 0n,
      topUpHeadroom:    raw.maxBudget  > raw.totalFunded ? raw.maxBudget  - raw.totalFunded : 0n,
    };
  } catch (err) {
    throw new BudgetRailError("SESSION_NOT_FOUND", `V2 readSession(${sessionId}) failed: ${(err as Error).message}`, true, err);
  }
}

/**
 * Verify the V2 contract's immutable TREASURY matches config.
 * Call at startup to catch misconfiguration early.
 */
export async function verifyV2Treasury(
  config: BudgetRailV2Config,
): Promise<void> {
  const client = makeClient(config);
  const onchain = (await client.readContract({
    address:      config.v2ContractAddress,
    abi:          BUDGET_RAIL_V2_ABI,
    functionName: "TREASURY",
    args:         [],
  })) as `0x${string}`;

  if (onchain.toLowerCase() !== config.treasuryAddress.toLowerCase()) {
    throw new BudgetRailError(
      "PROVIDER_MISMATCH",
      `V2 TREASURY onchain=${onchain} does not match config.treasuryAddress=${config.treasuryAddress}`,
    );
  }
}

/**
 * Decode a raw log into a PaymentSettledV2Event.
 * Returns null when the log is not a V2 PaymentSettledV2 event from the V2 contract.
 * Does NOT accept V1 PaymentSettled events — ABIs are kept separate.
 */
export function decodePaymentSettledV2Log(
  log: Log,
  v2ContractAddress: `0x${string}`,
): PaymentSettledV2Event | null {
  if (log.address.toLowerCase() !== v2ContractAddress.toLowerCase()) return null;
  try {
    const decoded = decodeEventLog({
      abi:       BUDGET_RAIL_V2_ABI,
      eventName: "PaymentSettledV2",
      data:      log.data,
      topics:    log.topics,
    });
    const args = decoded.args as {
      sessionId: bigint; requestId: `0x${string}`; provider: `0x${string}`;
      treasury: `0x${string}`; requestHash: `0x${string}`; agent: `0x${string}`;
      baseAmount: bigint; feeAmount: bigint; grossAmount: bigint; quoteDeadline: bigint;
    };
    return {
      sessionId:     args.sessionId,
      requestId:     args.requestId.toLowerCase()   as `0x${string}`,
      provider:      args.provider.toLowerCase()    as `0x${string}`,
      treasury:      args.treasury.toLowerCase()    as `0x${string}`,
      requestHash:   args.requestHash.toLowerCase() as `0x${string}`,
      agent:         args.agent.toLowerCase()       as `0x${string}`,
      baseAmount:    args.baseAmount,
      feeAmount:     args.feeAmount,
      grossAmount:   args.grossAmount,
      quoteDeadline: args.quoteDeadline,
    };
  } catch {
    return null;
  }
}

export interface ScannedPaymentV2 extends PaymentSettledV2Event {
  txHash: `0x${string}`;
  blockNumber: bigint;
}

/**
 * Scan for PaymentSettledV2 events from the V2 contract.
 * Uses the same retry/backoff/dedup logic as scanPaymentSettledEvents.
 * V1 and V2 events are kept strictly separate — never decode one as the other.
 */
export async function scanPaymentSettledV2Events(
  config: BudgetRailV2Config,
  opts?: ScanOptions,
): Promise<{ events: ScannedPaymentV2[]; coverage: CoverageMetadata }> {
  const client     = makeClient(config);
  const windowSize = opts?.windowSize ?? 5000n;
  const fromBlock  = opts?.fromBlock  ?? config.v2DeployBlock;
  const head       = await client.getBlockNumber();
  const toBlock    = opts?.toBlock !== undefined && opts.toBlock < head ? opts.toBlock : head;

  const seen    = new Set<string>();
  const results: ScannedPaymentV2[] = [];
  const failed:  FailedRange[]      = [];

  for (let start = fromBlock; start <= toBlock; start += windowSize + 1n) {
    const end = start + windowSize > toBlock ? toBlock : start + windowSize;
    let attempt = 0;
    let lastErr  = "";
    let succeeded = false;

    while (attempt < SDK_MAX_RETRIES) {
      try {
        const logs = await client.getLogs({
          address:   config.v2ContractAddress,
          fromBlock: start,
          toBlock:   end,
        });
        for (const log of logs) {
          const decoded = decodePaymentSettledV2Log(log as Log, config.v2ContractAddress);
          if (!decoded) continue;
          const key = `${log.transactionHash ?? ""}-${log.logIndex ?? 0}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({
            ...decoded,
            txHash:      (log.transactionHash ?? "0x") as `0x${string}`,
            blockNumber: log.blockNumber ?? 0n,
          });
        }
        succeeded = true;
        break;
      } catch (e) {
        lastErr = (e as Error).message;
        attempt++;
        if (attempt < SDK_MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, SDK_BACKOFF_MS * Math.pow(2, attempt - 1)));
        }
      }
    }
    if (!succeeded) failed.push({ fromBlock: start, toBlock: end, error: lastErr });
  }

  const isComplete = failed.length === 0 && fromBlock <= config.v2DeployBlock;
  const coverage: CoverageMetadata = { scannedFrom: fromBlock, scannedTo: toBlock, chainHead: head, isComplete, failedRanges: failed };

  if (failed.length > 0) {
    throw new IncompleteHistoryError(
      `V2 scan incomplete: ${failed.length} window(s) failed. Partial results (${results.length} events) in error.partialResults.`,
      results as unknown as import("./read.js").ScannedPayment[],
      coverage,
    );
  }

  return {
    events:   results.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1)),
    coverage,
  };
}
