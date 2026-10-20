/**
 * Transaction recovery metadata — safe persistence between CLI runs.
 *
 * Persists the minimum information needed to resume a failed run:
 *   - transaction hash (public onchain data — safe to store)
 *   - request ID and session ID (public onchain data)
 *   - original input text and signed quote (needed for /api/fulfill)
 *
 * NEVER stores private keys, signing materials, or any secret.
 *
 * File location: ./agent-recovery/<requestId>.json (relative to CWD).
 * The file is deleted on successful fulfillment.
 */

import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SignedQuote } from "./eip712.js";

const RECOVERY_DIR = "./agent-recovery";

export interface RecoveryRecord {
  version:    1;
  createdAt:  string;         // ISO-8601
  sessionId:  string;         // bigint as string
  requestId:  `0x${string}`;  // bytes32 hex
  txHash:     `0x${string}`;  // submitted tx hash
  input:      string;         // original text input
  quote:      SignedQuote;    // full signed quote for re-fulfillment
  network:    "testnet" | "mainnet";
  contractAddress: `0x${string}`;
  explorerTxUrl:   string;
}

export function recoveryPath(requestId: `0x${string}`): string {
  return resolve(join(RECOVERY_DIR, `${requestId}.json`));
}

export async function saveRecovery(record: RecoveryRecord): Promise<string> {
  await mkdir(RECOVERY_DIR, { recursive: true });
  const path = recoveryPath(record.requestId);
  await writeFile(path, JSON.stringify(record, null, 2), "utf-8");
  return path;
}

export async function loadRecovery(requestId: `0x${string}`): Promise<RecoveryRecord | null> {
  try {
    const raw = await readFile(recoveryPath(requestId), "utf-8");
    return JSON.parse(raw) as RecoveryRecord;
  } catch {
    return null;
  }
}

export async function deleteRecovery(requestId: `0x${string}`): Promise<void> {
  try {
    await unlink(recoveryPath(requestId));
  } catch { /* already gone */ }
}
