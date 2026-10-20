/**
 * historyScanner.ts — unified BudgetRail activity scanner (frontend).
 *
 * Fetches ALL four V1 event types from the BudgetRail contract:
 *   SessionCreated  — owner created a new session
 *   SessionFunded   — owner deposited USDC
 *   PaymentSettled  — agent paid for a request
 *   SessionClosed   — owner closed and was refunded
 *
 * Design guarantees:
 *  1. Windowed getLogs (≤ WINDOW_SIZE blocks per call) — never one unbounded call.
 *  2. Exponential backoff on 429/timeout; NEVER silently skips a failed window.
 *  3. Dedup by `chainId + contractAddress + txHash + logIndex` (not requestId).
 *  4. Explicit CoverageResult: scannedFrom, chainHead, failedRanges, isComplete.
 *  5. Forward-walking cursor: scan from deployBlock → head, not head → deploy.
 *  6. onProgress callback with { scannedBlock, headBlock, windowsDone, windowsTotal }.
 *  7. Cancellable via AbortSignal.
 *  8. Versioned localStorage checkpoint key; stale entries auto-expire.
 *
 * Does NOT double-count ERC-20 Approvals or native gas as session events.
 * Does NOT scan the USDC contract — Transfer cross-check is left to fulfillment.
 */

import { createPublicClient, http, decodeEventLog } from "viem";
import { arcTestnet } from "viem/chains";
import { BUDGET_RAIL_ABI, DEPLOY_BLOCK_TESTNET } from "@/lib/budgetRail";

// ── Constants ────────────────────────────────────────────────────────────────

/** Max blocks per getLogs request. Arc Testnet RPC limit is 10 000; stay under it. */
export const WINDOW_SIZE = 9_999n;

/** Initial backoff before a retry, doubles on each attempt. */
const BASE_BACKOFF_MS = 800;

/** Max retry attempts per window before recording a failure. */
const MAX_RETRIES = 3;

/** Concurrency limit: how many getLogs calls in flight simultaneously. */
const CONCURRENCY = 2;

/** localStorage key prefix (bump version to invalidate old caches). */
const CACHE_VERSION = "v2";

/** Max age of a cached checkpoint in ms (5 minutes). */
const CACHE_MAX_AGE_MS = 5 * 60 * 1_000;

// ── Types ────────────────────────────────────────────────────────────────────

export type ActivityEventType =
  | "SessionCreated"
  | "SessionFunded"
  | "PaymentSettled"
  | "SessionClosed";

export type ActivityEventTab = "all" | "payments" | "deposits" | "refunds";

/** Raw decoded activity event — one row in the history feed. */
export interface ActivityEvent {
  /** Canonical dedup key. */
  key:         string;
  type:        ActivityEventType;
  txHash:      `0x${string}`;
  blockNumber: bigint;
  logIndex:    number;
  sessionId:   bigint;
  // ── SessionCreated ──
  owner?:        `0x${string}`;
  agent?:        `0x${string}`;
  provider?:     `0x${string}`;
  quoteSigner?:  `0x${string}`;
  maxBudget?:    bigint;
  perPaymentCap?: bigint;
  expiresAt?:    bigint;
  // ── SessionFunded ──
  fundAmount?:   bigint;
  totalFunded?:  bigint;
  // ── PaymentSettled ──
  requestId?:    `0x${string}`;
  requestHash?:  `0x${string}`;
  paymentAgent?: `0x${string}`;
  paymentProvider?: `0x${string}`;
  amount?:       bigint;
  quoteDeadline?: bigint;
  // ── SessionClosed ──
  refunded?:     bigint;
  totalSpent?:   bigint;
}

export interface FailedRange {
  fromBlock: bigint;
  toBlock:   bigint;
  error:     string;
}

export interface CoverageResult {
  events:       ActivityEvent[];
  scannedFrom:  bigint;
  scannedTo:    bigint;
  chainHead:    bigint;
  isComplete:   boolean;   // true only when scannedFrom === deployBlock AND no failedRanges
  failedRanges: FailedRange[];
  windowsDone:  number;
  windowsTotal: number;
}

export interface ScanProgress {
  scannedBlock: bigint;
  headBlock:    bigint;
  windowsDone:  number;
  windowsTotal: number;
  eventsSoFar:  number;
}

export interface ScanOptions {
  /** Start from this block. Defaults to DEPLOY_BLOCK_TESTNET. */
  fromBlock?: bigint;
  /** Scan only up to this block. Defaults to chain head. */
  toBlock?: bigint;
  /** Override window size (for testing). */
  windowSize?: bigint;
  /** Called after each window. */
  onProgress?: (p: ScanProgress) => void;
  /** Cancellation signal. */
  signal?: AbortSignal;
}

// ── Checkpoint cache ─────────────────────────────────────────────────────────

interface Checkpoint {
  version:     string;
  chainId:     number;
  contract:    string;
  fromBlock:   string;
  toBlock:     string;
  events:      ActivityEvent[];
  savedAt:     number;
}

function cacheKey(chainId: number, contract: string, fromBlock: bigint): string {
  return `br_history_${CACHE_VERSION}_${chainId}_${contract.toLowerCase()}_${fromBlock}`;
}

export function saveCheckpoint(
  chainId: number,
  contract: string,
  fromBlock: bigint,
  toBlock: bigint,
  events: ActivityEvent[],
): void {
  try {
    const key = cacheKey(chainId, contract, fromBlock);
    // Serialise bigints as strings for JSON
    const cp: Checkpoint = {
      version: CACHE_VERSION,
      chainId,
      contract: contract.toLowerCase(),
      fromBlock: fromBlock.toString(),
      toBlock:   toBlock.toString(),
      events:    events.map(serializeEvent),
      savedAt:   Date.now(),
    };
    localStorage.setItem(key, JSON.stringify(cp));
  } catch { /* storage unavailable */ }
}

export function loadCheckpoint(
  chainId: number,
  contract: string,
  fromBlock: bigint,
): { toBlock: bigint; events: ActivityEvent[] } | null {
  try {
    const key = cacheKey(chainId, contract, fromBlock);
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const cp = JSON.parse(raw) as Checkpoint;
    if (cp.version !== CACHE_VERSION) { localStorage.removeItem(key); return null; }
    if (Date.now() - cp.savedAt > CACHE_MAX_AGE_MS) { localStorage.removeItem(key); return null; }
    return {
      toBlock: BigInt(cp.toBlock),
      events:  cp.events.map(deserializeEvent),
    };
  } catch { return null; }
}

export function clearCheckpoint(chainId: number, contract: string, fromBlock: bigint): void {
  try { localStorage.removeItem(cacheKey(chainId, contract, fromBlock)); } catch { /* */ }
}

// Bigint fields need string round-trip for JSON.
function serializeEvent(e: ActivityEvent): ActivityEvent {
  return {
    ...e,
    sessionId:    e.sessionId,
    blockNumber:  e.blockNumber,
    maxBudget:    e.maxBudget,
    perPaymentCap: e.perPaymentCap,
    expiresAt:    e.expiresAt,
    fundAmount:   e.fundAmount,
    totalFunded:  e.totalFunded,
    amount:       e.amount,
    quoteDeadline: e.quoteDeadline,
    refunded:     e.refunded,
    totalSpent:   e.totalSpent,
  };
}

function deserializeEvent(e: ActivityEvent): ActivityEvent {
  // Events stored in JSON lose bigint — this recovers them from the raw object.
  function b(v: unknown): bigint | undefined {
    if (v === undefined || v === null) return undefined;
    try { return BigInt(v as string | number); } catch { return undefined; }
  }
  return {
    ...e,
    sessionId:    BigInt(e.sessionId),
    blockNumber:  BigInt(e.blockNumber),
    maxBudget:    b(e.maxBudget),
    perPaymentCap: b(e.perPaymentCap),
    expiresAt:    b(e.expiresAt),
    fundAmount:   b(e.fundAmount),
    totalFunded:  b(e.totalFunded),
    amount:       b(e.amount),
    quoteDeadline: b(e.quoteDeadline),
    refunded:     b(e.refunded),
    totalSpent:   b(e.totalSpent),
  };
}

// ── Event decoding ────────────────────────────────────────────────────────────

function tryDecodeEvent(
  log: { address: string; data: `0x${string}`; topics: readonly `0x${string}`[]; transactionHash?: string | null; blockNumber?: bigint | null; logIndex?: number | null },
  chainId: number,
  contract: string,
): ActivityEvent | null {
  if (log.address.toLowerCase() !== contract.toLowerCase()) return null;

  const txHash    = (log.transactionHash ?? "0x") as `0x${string}`;
  const blockNumber = log.blockNumber ?? 0n;
  const logIndex  = log.logIndex ?? 0;
  const key = `${chainId}-${contract.toLowerCase()}-${txHash}-${logIndex}`;

  // viem's decodeEventLog overloads require a mutable topics tuple type.
  // Cast once here; we never mutate the array.
  const mutableTopics = log.topics as [`0x${string}`, ...`0x${string}`[]];

  for (const eventName of ["SessionCreated", "SessionFunded", "PaymentSettled", "SessionClosed"] as const) {
    try {
      const decoded = decodeEventLog({
        abi: BUDGET_RAIL_ABI,
        eventName,
        data:   log.data,
        topics: mutableTopics,
      });
      const a = decoded.args as Record<string, unknown>;

      const base = { key, type: eventName, txHash, blockNumber, logIndex,
        sessionId: a.sessionId as bigint };

      switch (eventName) {
        case "SessionCreated":
          return { ...base, owner: a.owner as `0x${string}`, agent: a.agent as `0x${string}`,
            provider: a.provider as `0x${string}`, quoteSigner: a.quoteSigner as `0x${string}`,
            maxBudget: a.maxBudget as bigint, perPaymentCap: a.perPaymentCap as bigint,
            expiresAt: a.expiresAt as bigint };
        case "SessionFunded":
          return { ...base, owner: a.owner as `0x${string}`,
            fundAmount: a.amount as bigint, totalFunded: a.totalFunded as bigint };
        case "PaymentSettled":
          return { ...base, requestId: (a.requestId as `0x${string}`),
            requestHash: (a.requestHash as `0x${string}`),
            paymentAgent: (a.agent as `0x${string}`), paymentProvider: (a.provider as `0x${string}`),
            amount: a.amount as bigint, quoteDeadline: a.quoteDeadline as bigint };
        case "SessionClosed":
          return { ...base, owner: a.owner as `0x${string}`,
            refunded: a.refunded as bigint, totalSpent: a.totalSpent as bigint };
      }
    } catch { /* wrong event shape, try next */ }
  }
  return null;
}

// ── Core scanner ──────────────────────────────────────────────────────────────

/**
 * Scan the BudgetRail contract for all activity events from fromBlock to chain head.
 *
 * Guarantees:
 * - Never silently skips a failed window — records FailedRange instead.
 * - Exponential backoff on 429/timeout.
 * - Deduplicates by chainId+contract+txHash+logIndex.
 * - isComplete is only true when all windows succeeded and fromBlock === deployBlock.
 */
export async function scanAllEvents(
  contractAddress: `0x${string}`,
  opts: ScanOptions = {},
): Promise<CoverageResult> {
  const client = createPublicClient({
    chain: arcTestnet,
    transport: http(undefined, { timeout: 15_000 }),
  });

  const chainId    = arcTestnet.id;
  const winSize    = opts.windowSize ?? WINDOW_SIZE;
  const fromBlock  = opts.fromBlock ?? DEPLOY_BLOCK_TESTNET;
  const chainHead  = await client.getBlockNumber();
  const toBlock    = opts.toBlock !== undefined && opts.toBlock <= chainHead
    ? opts.toBlock
    : chainHead;

  // Build the full list of windows up front so we know windowsTotal.
  const windows: Array<{ from: bigint; to: bigint }> = [];
  for (let start = fromBlock; start <= toBlock; start += winSize + 1n) {
    const end = start + winSize > toBlock ? toBlock : start + winSize;
    windows.push({ from: start, to: end });
  }

  const totalWindows = windows.length;
  const seen     = new Set<string>();
  const events:       ActivityEvent[] = [];
  const failedRanges: FailedRange[]   = [];
  let windowsDone = 0;

  // Process windows in bounded concurrency batches.
  for (let i = 0; i < windows.length; i += CONCURRENCY) {
    if (opts.signal?.aborted) break;

    const batch = windows.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (win) => {
        if (opts.signal?.aborted) return { logs: [], failed: null };

        let attempt = 0;
        let lastErr = "";
        while (attempt < MAX_RETRIES) {
          try {
            const logs = await client.getLogs({
              address:   contractAddress,
              fromBlock: win.from,
              toBlock:   win.to,
            });
            return { logs, failed: null };
          } catch (e) {
            lastErr = (e as Error).message;
            attempt++;
            if (attempt < MAX_RETRIES) {
              await sleep(BASE_BACKOFF_MS * Math.pow(2, attempt - 1));
            }
          }
        }
        return { logs: [], failed: { fromBlock: win.from, toBlock: win.to, error: lastErr } };
      }),
    );

    for (let j = 0; j < batchResults.length; j++) {
      const { logs, failed } = batchResults[j];
      const win = batch[j];

      if (failed) {
        failedRanges.push(failed);
      } else {
        for (const log of logs) {
          const decoded = tryDecodeEvent(
            log,
            chainId,
            contractAddress,
          );
          if (!decoded || seen.has(decoded.key)) continue;
          seen.add(decoded.key);
          events.push(decoded);
        }
      }

      windowsDone++;
      opts.onProgress?.({
        scannedBlock: win.to,
        headBlock:    chainHead,
        windowsDone,
        windowsTotal: totalWindows,
        eventsSoFar:  events.length,
      });
    }
  }

  // Sort: ascending block → transactionIndex is not available in logs, use logIndex.
  events.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });

  const isComplete = failedRanges.length === 0 &&
    !opts.signal?.aborted &&
    fromBlock <= DEPLOY_BLOCK_TESTNET;

  return {
    events,
    scannedFrom:  fromBlock,
    scannedTo:    toBlock,
    chainHead,
    isComplete,
    failedRanges,
    windowsDone,
    windowsTotal: totalWindows,
  };
}

// ── Recent-only helper (Dashboard) ───────────────────────────────────────────

/**
 * Fast recent-activity scan for the Dashboard.
 * Scans only the last `recentWindows` × WINDOW_SIZE blocks.
 * Returns the same CoverageResult shape; isComplete will be false unless
 * the chain is so short that it starts before DEPLOY_BLOCK_TESTNET.
 */
export async function scanRecentEvents(
  contractAddress: `0x${string}`,
  recentWindows = 3,
  opts: Pick<ScanOptions, "signal" | "onProgress"> = {},
): Promise<CoverageResult> {
  const client = createPublicClient({
    chain: arcTestnet,
    transport: http(undefined, { timeout: 15_000 }),
  });
  const chainHead = await client.getBlockNumber();
  const fromBlock = chainHead > WINDOW_SIZE * BigInt(recentWindows) + DEPLOY_BLOCK_TESTNET
    ? chainHead - WINDOW_SIZE * BigInt(recentWindows)
    : DEPLOY_BLOCK_TESTNET;

  return scanAllEvents(contractAddress, {
    fromBlock,
    toBlock: chainHead,
    ...opts,
  });
}

// ── Tab filter ───────────────────────────────────────────────────────────────

export function filterByTab(events: ActivityEvent[], tab: ActivityEventTab): ActivityEvent[] {
  switch (tab) {
    case "payments":  return events.filter(e => e.type === "PaymentSettled");
    case "deposits":  return events.filter(e => e.type === "SessionFunded" || e.type === "SessionCreated");
    case "refunds":   return events.filter(e => e.type === "SessionClosed");
    case "all":
    default:          return events;
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Human-readable label for each event type. */
export function eventTypeLabel(type: ActivityEventType): string {
  switch (type) {
    case "SessionCreated":  return "Session created";
    case "SessionFunded":   return "Deposit";
    case "PaymentSettled":  return "Payment";
    case "SessionClosed":   return "Closed & refunded";
  }
}

/** Tailwind colour class for each event type (for the dot / badge). */
export function eventTypeColor(type: ActivityEventType): string {
  switch (type) {
    case "SessionCreated":  return "text-[var(--accent)]";
    case "SessionFunded":   return "text-blue-400";
    case "PaymentSettled":  return "text-[var(--success)]";
    case "SessionClosed":   return "text-[var(--subtle)]";
  }
}
