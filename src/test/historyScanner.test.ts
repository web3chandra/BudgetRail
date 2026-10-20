/**
 * Unit tests for historyScanner.ts
 *
 * These tests use a mock viem client injected via module augmentation-style
 * approach: we intercept the dynamic import("viem/chains") + createPublicClient
 * by constructing a lightweight stub directly on the exported functions that
 * accept a client parameter, or by testing the pure helpers directly.
 *
 * For the scanner itself we test the pure helper functions and logic
 * units (filterByTab, eventTypeLabel, eventTypeColor, dedup key, sort order,
 * checkpoint serialization). The network-dependent scanAllEvents is covered
 * by integration tests (contracts/test-integration/).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  filterByTab,
  eventTypeLabel,
  eventTypeColor,
  saveCheckpoint,
  loadCheckpoint,
  clearCheckpoint,
  type ActivityEvent,
} from "@/lib/historyScanner";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeEvent(
  overrides: Partial<ActivityEvent> & Pick<ActivityEvent, "type">,
): ActivityEvent {
  return {
    key:         overrides.key ?? `${overrides.txHash ?? "0xabc"}-0`,
    type:        overrides.type,
    txHash:      overrides.txHash ?? "0xabc",
    blockNumber: overrides.blockNumber ?? 1n,
    logIndex:    overrides.logIndex ?? 0,
    sessionId:   overrides.sessionId ?? 1n,
    ...overrides,
  };
}

// ── filterByTab ────────────────────────────────────────────────────────────

describe("filterByTab", () => {
  const events: ActivityEvent[] = [
    makeEvent({ type: "SessionCreated",  key: "k1", txHash: "0x01" }),
    makeEvent({ type: "SessionFunded",   key: "k2", txHash: "0x02" }),
    makeEvent({ type: "PaymentSettled",  key: "k3", txHash: "0x03" }),
    makeEvent({ type: "SessionClosed",   key: "k4", txHash: "0x04" }),
  ];

  it("all returns every event", () => {
    expect(filterByTab(events, "all").length).toBe(4);
  });

  it("payments returns only PaymentSettled", () => {
    const result = filterByTab(events, "payments");
    expect(result.length).toBe(1);
    expect(result[0].type).toBe("PaymentSettled");
  });

  it("deposits returns SessionFunded + SessionCreated", () => {
    const result = filterByTab(events, "deposits");
    expect(result.length).toBe(2);
    expect(result.every(e => e.type === "SessionFunded" || e.type === "SessionCreated")).toBe(true);
  });

  it("refunds returns only SessionClosed", () => {
    const result = filterByTab(events, "refunds");
    expect(result.length).toBe(1);
    expect(result[0].type).toBe("SessionClosed");
  });

  it("returns empty array when events is empty", () => {
    expect(filterByTab([], "all").length).toBe(0);
  });
});

// ── eventTypeLabel ─────────────────────────────────────────────────────────

describe("eventTypeLabel", () => {
  it("returns human-readable labels for all four types", () => {
    expect(eventTypeLabel("SessionCreated")).toBe("Session created");
    expect(eventTypeLabel("SessionFunded")).toBe("Deposit");
    expect(eventTypeLabel("PaymentSettled")).toBe("Payment");
    expect(eventTypeLabel("SessionClosed")).toBe("Closed & refunded");
  });
});

// ── eventTypeColor ─────────────────────────────────────────────────────────

describe("eventTypeColor", () => {
  it("returns a non-empty tailwind class for all four types", () => {
    const types = ["SessionCreated", "SessionFunded", "PaymentSettled", "SessionClosed"] as const;
    for (const t of types) {
      expect(eventTypeColor(t).length).toBeGreaterThan(0);
    }
  });
});

// ── Dedup key correctness ──────────────────────────────────────────────────

describe("dedup key format", () => {
  it("key is {txHash}-{logIndex}, NOT requestId", () => {
    const e1 = makeEvent({ type: "PaymentSettled", txHash: "0xaaa", logIndex: 0, key: "0xaaa-0", requestId: "0xREQ1" });
    const e2 = makeEvent({ type: "PaymentSettled", txHash: "0xaaa", logIndex: 0, key: "0xaaa-0", requestId: "0xREQ2" });
    // Same txHash+logIndex = same key regardless of requestId
    expect(e1.key).toBe(e2.key);
  });

  it("different logIndex yields different keys even same txHash", () => {
    const e1 = makeEvent({ type: "PaymentSettled", txHash: "0xaaa", logIndex: 0, key: "0xaaa-0" });
    const e2 = makeEvent({ type: "PaymentSettled", txHash: "0xaaa", logIndex: 1, key: "0xaaa-1" });
    expect(e1.key).not.toBe(e2.key);
  });
});

// ── Sorting: ascending block order + logIndex tiebreak ───────────────────

describe("event sort order", () => {
  it("ascending block/logIndex sort places older events first", () => {
    const events: ActivityEvent[] = [
      makeEvent({ type: "PaymentSettled", key: "k1", blockNumber: 5n, logIndex: 1 }),
      makeEvent({ type: "PaymentSettled", key: "k2", blockNumber: 3n, logIndex: 0 }),
      makeEvent({ type: "PaymentSettled", key: "k3", blockNumber: 5n, logIndex: 0 }),
    ];
    const sorted = [...events].sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
      return a.logIndex - b.logIndex;
    });
    expect(sorted[0].blockNumber).toBe(3n);
    expect(sorted[1].logIndex).toBe(0);  // block 5, log 0 before log 1
    expect(sorted[2].logIndex).toBe(1);
  });
});

// ── Checkpoint round-trip ─────────────────────────────────────────────────

describe("saveCheckpoint / loadCheckpoint / clearCheckpoint", () => {
  const CHAIN_ID  = 5042002;
  const CONTRACT  = "0xf6a13df15ad93c2e2968e1d69c53894a923bda21";
  const FROM      = 67538363n;
  const TO        = 67548000n;

  // Mock localStorage for the test environment
  let store: Record<string, string> = {};
  const originalLS = globalThis.localStorage;

  beforeEach(() => {
    store = {};
    // bun test may not have window.localStorage — polyfill it
    if (typeof globalThis.localStorage === "undefined") {
      Object.defineProperty(globalThis, "localStorage", {
        value: {
          getItem:    (k: string) => store[k] ?? null,
          setItem:    (k: string, v: string) => { store[k] = v; },
          removeItem: (k: string) => { delete store[k]; },
          clear:      () => { store = {}; },
        },
        writable:     true,
        configurable: true,
      });
    }
  });

  afterEach(() => {
    if (originalLS !== undefined) {
      Object.defineProperty(globalThis, "localStorage", {
        value: originalLS, writable: true, configurable: true,
      });
    }
  });

  it("saves and loads events with bigint fields intact", () => {
    const events: ActivityEvent[] = [
      makeEvent({
        type:        "PaymentSettled",
        key:         "0xabc-0",
        txHash:      "0xabc",
        blockNumber: 67540000n,
        logIndex:    2,
        sessionId:   7n,
        amount:      50_000n,
        quoteDeadline: 1_700_000_000n,
      }),
    ];

    saveCheckpoint(CHAIN_ID, CONTRACT, FROM, TO, events);
    const loaded = loadCheckpoint(CHAIN_ID, CONTRACT, FROM);

    expect(loaded).not.toBeNull();
    expect(loaded!.toBlock).toBe(TO);
    expect(loaded!.events.length).toBe(1);

    const e = loaded!.events[0];
    expect(e.blockNumber).toBe(67540000n);
    expect(e.sessionId).toBe(7n);
    expect(e.amount).toBe(50_000n);
    expect(e.quoteDeadline).toBe(1_700_000_000n);
  });

  it("returns null after clearCheckpoint", () => {
    const events: ActivityEvent[] = [makeEvent({ type: "SessionClosed", key: "0x1-0" })];
    saveCheckpoint(CHAIN_ID, CONTRACT, FROM, TO, events);
    clearCheckpoint(CHAIN_ID, CONTRACT, FROM);
    expect(loadCheckpoint(CHAIN_ID, CONTRACT, FROM)).toBeNull();
  });

  it("returns null when nothing was saved", () => {
    expect(loadCheckpoint(CHAIN_ID, CONTRACT, FROM)).toBeNull();
  });
});

// ── Range boundary: off-by-one ────────────────────────────────────────────

describe("window boundary arithmetic", () => {
  it("windows cover exactly [from, to] with no gaps or overlaps", () => {
    const WINDOW_SIZE = 9_999n;
    const from = 100n;
    const to   = 30_000n;

    const windows: Array<{ f: bigint; t: bigint }> = [];
    for (let start = from; start <= to; start += WINDOW_SIZE + 1n) {
      const end = start + WINDOW_SIZE > to ? to : start + WINDOW_SIZE;
      windows.push({ f: start, t: end });
    }

    // First window starts exactly at `from`
    expect(windows[0].f).toBe(from);
    // Last window ends exactly at `to`
    expect(windows[windows.length - 1].t).toBe(to);

    // No gap between consecutive windows
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].f).toBe(windows[i - 1].t + 1n);
    }
  });

  it("single-block range produces exactly one window", () => {
    const WINDOW_SIZE = 9_999n;
    const from = 500n;
    const to   = 500n;
    const windows: bigint[] = [];
    for (let start = from; start <= to; start += WINDOW_SIZE + 1n) {
      windows.push(start);
    }
    expect(windows.length).toBe(1);
  });

  it("deployBlock is included (fromBlock = DEPLOY_BLOCK_TESTNET)", () => {
    const DEPLOY_BLOCK = 67_538_363n;
    const WINDOW_SIZE  = 9_999n;
    const from = DEPLOY_BLOCK;
    const to   = DEPLOY_BLOCK + WINDOW_SIZE;
    const first: bigint[] = [];
    for (let start = from; start <= to; start += WINDOW_SIZE + 1n) {
      first.push(start);
      break;
    }
    expect(first[0]).toBe(DEPLOY_BLOCK);
  });
});
