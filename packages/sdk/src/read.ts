/**
 * BudgetRail SDK — Read operations (no signing, no private keys).
 *
 * All functions accept a viem PublicClient-compatible object or a raw RPC URL.
 */

import { createPublicClient, http, decodeEventLog, type Log } from "viem";
import { BUDGET_RAIL_ABI, DEPLOY_BLOCK_TESTNET } from "./abi.js";
import { BudgetRailError } from "./types.js";
import type { BudgetRailConfig, Session, PaymentSettledEvent } from "./types.js";

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
 */
export async function scanPaymentSettledEvents(
  config: BudgetRailConfig,
  opts?: ScanOptions,
): Promise<ScannedPayment[]> {
  const client = makeClient(config);
  const windowSize = opts?.windowSize ?? 5000n;
  const fromBlock  = opts?.fromBlock  ?? DEPLOY_BLOCK_TESTNET;
  const head       = await client.getBlockNumber();
  const toBlock    = opts?.toBlock !== undefined && opts.toBlock < head ? opts.toBlock : head;

  const seen = new Set<string>();
  const results: ScannedPayment[] = [];

  for (let start = fromBlock; start <= toBlock; start += windowSize + 1n) {
    const end = start + windowSize > toBlock ? toBlock : start + windowSize;
    try {
      const logs = await client.getLogs({
        address: config.contractAddress,
        fromBlock: start,
        toBlock:   end,
      });
      for (const log of logs) {
        const decoded = decodePaymentSettledLog(log as Log);
        if (!decoded) continue;
        const key = `${decoded.requestId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          ...decoded,
          txHash:      (log.transactionHash ?? "0x") as `0x${string}`,
          blockNumber: log.blockNumber ?? 0n,
        });
      }
    } catch {
      // RPC may reject large ranges; skip this window and continue
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return results.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1));
}
