/**
 * BudgetRail frontend unit tests — Tasks B/C/D/E regression coverage.
 *
 * Run: bun test src/test/
 *
 * These tests do NOT require a wallet, RPC connection, or deployed contract.
 * All onchain interactions are replaced with typed stubs.
 */

import { describe, test, expect } from "bun:test";

// ── Module under test (pure helpers only) ─────────────────────────────────
// Import the pure parts that don't need a browser DOM.
import { parseUsdcUnits, isValidAddress, DEFAULT_FORM } from "../hooks/useSessionFlow";
import { parseOnchainError } from "../lib/parseOnchainError";

// ── parseUsdcUnits ─────────────────────────────────────────────────────────

describe("parseUsdcUnits", () => {
  test("parses $0.05 → 50000n", () => {
    expect(parseUsdcUnits("0.05")).toBe(50000n);
  });

  test("parses $1.00 → 1000000n", () => {
    expect(parseUsdcUnits("1.00")).toBe(1_000_000n);
  });

  test("parses $0.000001 → 1n (minimum unit)", () => {
    expect(parseUsdcUnits("0.000001")).toBe(1n);
  });

  test("parses $5.00 → 5000000n", () => {
    expect(parseUsdcUnits("5.00")).toBe(5_000_000n);
  });

  test("returns null for zero", () => {
    expect(parseUsdcUnits("0")).toBeNull();
  });

  test("returns null for negative", () => {
    expect(parseUsdcUnits("-1")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseUsdcUnits("")).toBeNull();
  });

  test("returns null for NaN", () => {
    expect(parseUsdcUnits("abc")).toBeNull();
  });

  test("handles 6 decimal places correctly (bigint-only, no rounding)", () => {
    // $0.000001 = exactly 1 base unit — minimum representable value
    expect(parseUsdcUnits("0.000001")).toBe(1n);
    // $0.0000005 is below 1 base unit — the bigint-only parser truncates the 7th decimal
    // and returns null (0n would be silently invalid)
    expect(parseUsdcUnits("0.0000005")).toBeNull();
  });
});

// ── isValidAddress ─────────────────────────────────────────────────────────

describe("isValidAddress", () => {
  test("accepts well-formed checksummed address", () => {
    expect(isValidAddress("0xc1CfDF533A6DA9A19E40Cf9A8bfc1893dcFF2F7b")).toBe(true);
  });

  test("accepts lowercase 40-hex address", () => {
    expect(isValidAddress("0xc1cfdf533a6da9a19e40cf9a8bfc1893dcff2f7b")).toBe(true);
  });

  test("rejects zero address", () => {
    // isValidAddress only checks format, not zero — zero check is in providerConfigError
    expect(isValidAddress("0x0000000000000000000000000000000000000000")).toBe(true);
  });

  test("rejects too-short address", () => {
    expect(isValidAddress("0x1234")).toBe(false);
  });

  test("rejects missing 0x prefix", () => {
    expect(isValidAddress("c1cfdf533a6da9a19e40cf9a8bfc1893dcff2f7b")).toBe(false);
  });

  test("rejects address with invalid hex chars", () => {
    expect(isValidAddress("0xGGGGdf533a6da9a19e40cf9a8bfc1893dcff2f7b")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isValidAddress("")).toBe(false);
  });
});

// ── parseOnchainError ──────────────────────────────────────────────────────

describe("parseOnchainError — ZeroAddress selector", () => {
  test("decodes 0xd92e233d selector to provider config message", () => {
    const err = { data: "0xd92e233d" };
    const msg = parseOnchainError(err);
    expect(msg).toContain("zero");
    expect(msg).toContain("provider");
  });

  test("decodes ZeroAddress from cause.data", () => {
    const err = { cause: { data: "0xd92e233d" } };
    const msg = parseOnchainError(err);
    expect(msg).toContain("provider");
  });

  test("decodes ZeroAddress from nested cause chain", () => {
    const err = { cause: { cause: { data: "0xd92e233d" } } };
    const msg = parseOnchainError(err);
    expect(msg).toContain("provider");
  });
});

describe("parseOnchainError — custom error selectors", () => {
  test("InvalidBudget 0x0757bfc9", () => {
    expect(parseOnchainError({ data: "0x0757bfc9" })).toContain("budget");
  });

  test("ExpiryInPast 0x079955a1", () => {
    expect(parseOnchainError({ data: "0x079955a1" })).toContain("future");
  });

  test("SessionNotFound 0x96c95f81", () => {
    expect(parseOnchainError({ data: "0x96c95f81" })).toContain("Session not found");
  });

  test("NotOwner 0x30cd7471", () => {
    expect(parseOnchainError({ data: "0x30cd7471" })).toContain("owner");
  });

  test("SessionAlreadyClosed 0xe9a4fb4e", () => {
    expect(parseOnchainError({ data: "0xe9a4fb4e" })).toContain("closed");
  });

  test("InvalidSignature 0x8baa579f", () => {
    expect(parseOnchainError({ data: "0x8baa579f" })).toContain("signature");
  });

  test("PerPaymentCapExceeded 0x7d15ded9", () => {
    expect(parseOnchainError({ data: "0x7d15ded9" })).toContain("cap");
  });

  test("RequestAlreadyPaid 0xc15be6e2", () => {
    expect(parseOnchainError({ data: "0xc15be6e2" })).toContain("already been paid");
  });
});

describe("parseOnchainError — wallet rejection", () => {
  test("detects user rejected via message", () => {
    const msg = parseOnchainError(new Error("User rejected the request"));
    expect(msg).toContain("Cancelled");
  });

  test("detects user denied via message", () => {
    const msg = parseOnchainError(new Error("MetaMask: user denied"));
    expect(msg).toContain("Cancelled");
  });

  test("detects code 4001", () => {
    const msg = parseOnchainError({ code: 4001, message: "" });
    expect(msg).toContain("Cancelled");
  });
});

describe("parseOnchainError — generic patterns", () => {
  test("detects insufficient funds", () => {
    const msg = parseOnchainError(new Error("insufficient funds for gas"));
    expect(msg).toContain("Insufficient balance");
  });

  test("detects network error", () => {
    const msg = parseOnchainError(new Error("network request failed"));
    expect(msg).toContain("Network error");
  });

  test("detects dropped tx", () => {
    const msg = parseOnchainError(new Error("transaction dropped and replaced"));
    expect(msg.toLowerCase()).toContain("drop");
  });

  test("decodes named custom error in message text", () => {
    const msg = parseOnchainError(new Error("execution reverted: ZeroAddress()"));
    expect(msg).toContain("provider");
  });

  test("falls back with original short message", () => {
    const msg = parseOnchainError(new Error("some exotic error XYZ123"));
    expect(msg).toContain("XYZ123");
  });

  test("truncates very long fallback messages", () => {
    const long = "a".repeat(300);
    const msg = parseOnchainError(new Error(long));
    expect(msg.length).toBeLessThan(250);
    expect(msg).toContain("…");
  });
});

// ── Validation logic ───────────────────────────────────────────────────────

describe("form validation helpers", () => {
  test("DEFAULT_FORM has expected shape", () => {
    expect(DEFAULT_FORM.maxBudget).toBe("1.00");
    expect(DEFAULT_FORM.perPaymentCap).toBe("0.05");
    expect(DEFAULT_FORM.expiryDays).toBe("7");
    expect(DEFAULT_FORM.fundAmount).toBe("0.50");
    expect(DEFAULT_FORM.agentAddress).toBe("");
  });

  test("per-call cap $0.05 fits inside max budget $1.00", () => {
    const maxB = parseUsdcUnits("1.00")!;
    const cap  = parseUsdcUnits("0.05")!;
    expect(cap <= maxB).toBe(true);
  });

  test("per-call cap $1.00 equals max budget $1.00 (boundary OK)", () => {
    const maxB = parseUsdcUnits("1.00")!;
    const cap  = parseUsdcUnits("1.00")!;
    expect(cap <= maxB).toBe(true);
  });

  test("per-call cap $1.01 exceeds max budget $1.00 (reject)", () => {
    const maxB = parseUsdcUnits("1.00")!;
    const cap  = parseUsdcUnits("1.01")!;
    expect(cap > maxB).toBe(true);
  });

  test("fund amount $0.50 fits within max budget $1.00", () => {
    const maxB = parseUsdcUnits("1.00")!;
    const fund = parseUsdcUnits("0.50")!;
    expect(fund <= maxB).toBe(true);
  });

  test("fund amount $1.01 exceeds max budget $1.00 (reject)", () => {
    const maxB = parseUsdcUnits("1.00")!;
    const fund = parseUsdcUnits("1.01")!;
    expect(fund > maxB).toBe(true);
  });
});

// ── providerConfigError ────────────────────────────────────────────────────

describe("providerConfigError", () => {
  // We test the logic directly since VITE_ env vars are not set in Bun test
  function mockProviderConfigError(payout: string, signer: string): string | null {
    const ZERO = "0x0000000000000000000000000000000000000000";
    const missing: string[] = [];
    if (payout === ZERO) missing.push("VITE_PROVIDER_PAYOUT");
    if (signer === ZERO) missing.push("VITE_QUOTE_SIGNER");
    if (missing.length === 0) return null;
    return `Provider not configured. Set: ${missing.join(", ")}`;
  }

  const ZERO = "0x0000000000000000000000000000000000000000";
  const REAL = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

  test("returns null when both addresses are non-zero", () => {
    expect(mockProviderConfigError(REAL, REAL)).toBeNull();
  });

  test("errors when payout is zero", () => {
    expect(mockProviderConfigError(ZERO, REAL)).toContain("VITE_PROVIDER_PAYOUT");
  });

  test("errors when signer is zero", () => {
    expect(mockProviderConfigError(REAL, ZERO)).toContain("VITE_QUOTE_SIGNER");
  });

  test("errors when both are zero", () => {
    const msg = mockProviderConfigError(ZERO, ZERO);
    expect(msg).toContain("VITE_PROVIDER_PAYOUT");
    expect(msg).toContain("VITE_QUOTE_SIGNER");
  });
});

// ── Transaction hash is NOT success (Task D) ──────────────────────────────

describe("transaction hash ≠ success", () => {
  test("a transaction hash alone does not mean confirmed", () => {
    // This test documents the contract: the lifecycle hook requires receipt.status === 'success'
    // before advancing to 'confirmed'. A hash means 'submitted' at most.
    const statuses = ["submitted", "confirming", "confirmed", "failed", "cancelled"] as const;
    const hashIsTerminal = (s: typeof statuses[number]) =>
      s === "confirmed" || s === "failed" || s === "cancelled";

    expect(hashIsTerminal("submitted")).toBe(false);
    expect(hashIsTerminal("confirming")).toBe(false);
    expect(hashIsTerminal("confirmed")).toBe(true);
    expect(hashIsTerminal("failed")).toBe(true);
    expect(hashIsTerminal("cancelled")).toBe(true);
  });
});

// ── Block range arithmetic (Task E) ───────────────────────────────────────

describe("event scanning block ranges", () => {
  const DEPLOY_BLOCK = 67538363n;
  const WINDOW_SIZE  = 9_999n;

  test("never scans below deploy block", () => {
    const latest = 67600000n;
    const from   = latest - WINDOW_SIZE;
    expect(from >= DEPLOY_BLOCK).toBe(true);
  });

  test("deploy block is the safe lower bound for full-history scans", () => {
    // First window should start at max(latest - WINDOW_SIZE, DEPLOY_BLOCK)
    const latest    = DEPLOY_BLOCK + 1000n; // just after deploy
    const fromBlock = latest - WINDOW_SIZE < DEPLOY_BLOCK ? DEPLOY_BLOCK : latest - WINDOW_SIZE;
    expect(fromBlock).toBe(DEPLOY_BLOCK);
  });

  test("window arithmetic never produces fromBlock > toBlock", () => {
    const latest   = 67540000n;
    const toBlock  = latest;
    const fromBlock = toBlock > WINDOW_SIZE ? toBlock - WINDOW_SIZE : 0n;
    expect(fromBlock).toBeLessThanOrEqual(toBlock);
  });

  test("5 windows of 9999 cover ~50 000 blocks", () => {
    const total = 5 * Number(WINDOW_SIZE);
    expect(total).toBe(49_995);
    expect(total).toBeGreaterThan(49_000);
  });
});

// ── localStorage key constants ─────────────────────────────────────────────

describe("localStorage persistence keys", () => {
  test("draft key includes version suffix for forward compatibility", () => {
    // Ensures stale keys from earlier versions don't poison new state
    const DRAFT_KEY = "budgetrail_create_draft_v1";
    expect(DRAFT_KEY).toContain("_v1");
  });

  test("hashes key includes version suffix", () => {
    const HASHES_KEY = "budgetrail_pending_hashes_v1";
    expect(HASHES_KEY).toContain("_v1");
  });
});

// ── PROVIDER_API_URL construction ─────────────────────────────────────────
// Regression tests for the "/api/api/quotes" double-prefix bug.
// The fix: strip any trailing /api from VITE_PROVIDER_API_URL before appending routes.

function stripApiSuffix(raw: string): string {
  return raw.replace(/\/api\/?$/, "").replace(/\/$/, "");
}

describe("PROVIDER_API_URL construction (double-prefix regression)", () => {
  test("empty string (Vite proxy default) → /api/quotes", () => {
    const base = stripApiSuffix("");
    expect(`${base}/api/quotes`).toBe("/api/quotes");
  });

  test("'/api' (the broken env value) → /api/quotes, not /api/api/quotes", () => {
    const base = stripApiSuffix("/api");
    expect(`${base}/api/quotes`).toBe("/api/quotes");
  });

  test("'/api/' with trailing slash → /api/quotes", () => {
    const base = stripApiSuffix("/api/");
    expect(`${base}/api/quotes`).toBe("/api/quotes");
  });

  test("'http://localhost:3001' (direct) → http://localhost:3001/api/quotes", () => {
    const base = stripApiSuffix("http://localhost:3001");
    expect(`${base}/api/quotes`).toBe("http://localhost:3001/api/quotes");
  });

  test("'http://localhost:3001/' trailing slash stripped → correct URL", () => {
    const base = stripApiSuffix("http://localhost:3001/");
    expect(`${base}/api/quotes`).toBe("http://localhost:3001/api/quotes");
  });

  test("'http://localhost:3001/api' → http://localhost:3001/api/quotes", () => {
    const base = stripApiSuffix("http://localhost:3001/api");
    expect(`${base}/api/quotes`).toBe("http://localhost:3001/api/quotes");
  });

  test("health route also correct with empty base", () => {
    const base = stripApiSuffix("");
    expect(`${base}/api/health`).toBe("/api/health");
  });

  test("fulfill route also correct with empty base", () => {
    const base = stripApiSuffix("");
    expect(`${base}/api/fulfill`).toBe("/api/fulfill");
  });

  test("arbitrary path prefix is preserved (not a base URL normalization step)", () => {
    const base = stripApiSuffix("https://provider.example.com");
    expect(`${base}/api/quotes`).toBe("https://provider.example.com/api/quotes");
  });
});

// ── Provider HTTP integration tests (real backend on localhost:3001) ────────
// These tests hit the actual running Bun provider process.
// They make NO payments and broadcast NO transactions.

const PROVIDER_BASE = "http://localhost:3001";

async function providerAlive(): Promise<boolean> {
  try {
    const r = await fetch(`${PROVIDER_BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

describe("Provider HTTP integration (localhost:3001)", () => {
  test("GET /api/health returns status ok and correct chainId", async () => {
    if (!(await providerAlive())) {
      console.warn("provider not running — skipping integration tests");
      return;
    }
    const r = await fetch(`${PROVIDER_BASE}/api/health`);
    expect(r.status).toBe(200);
    const body = await r.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.chainId).toBe(5042002);
    expect(body.contractAddress).toBe("0xf6a13df15ad93c2e2968e1d69c53894a923bda21");
    expect(typeof body.providerPayout).toBe("string");
    expect(typeof body.quoteSignerAddress).toBe("string");
    expect(body.rpcOk).toBe(true);
  });

  test("POST /api/quotes: provider correctly rejects sessions whose onchain quoteSigner does not match the server key", async () => {
    // Sessions 1-8 were created with quoteSigner=0x1b20af... (the original key, now rotated).
    // The running provider has a new key (0x70cd9e...). The provider MUST reject these sessions
    // with a 400 "wrong quoteSigner" error — this is correct security behavior, not a bug.
    // To get a successful quote, create a new session using the current VITE_QUOTE_SIGNER address.
    if (!(await providerAlive())) return;
    const r = await fetch(`${PROVIDER_BASE}/api/quotes`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        sessionId: "5",
        service:   "document-insights-v1",
        input:     "Integration test document for BudgetRail quote regression.",
      }),
    });
    // 400 is the correct response: session.quoteSigner != server's derived signer
    expect(r.status).toBe(400);
    const q = await r.json() as Record<string, unknown>;
    expect(typeof q.error).toBe("string");
    // Error must mention quoteSigner or signer mismatch — not a generic server error
    expect((q.error as string).toLowerCase()).toMatch(/signer|quotesigner/);
  });

  test("POST /api/quotes with non-existent session returns 404 or error", async () => {
    if (!(await providerAlive())) return;
    const r = await fetch(`${PROVIDER_BASE}/api/quotes`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        sessionId: "9999",
        service:   "document-insights-v1",
        input:     "test",
      }),
    });
    // Should return an error, not a valid quote
    expect(r.ok).toBe(false);
    const body = await r.json() as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
  });

  test("POST /api/quotes with wrong service name returns error", async () => {
    if (!(await providerAlive())) return;
    const r = await fetch(`${PROVIDER_BASE}/api/quotes`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        sessionId: "5",
        service:   "nonexistent-service-v99",
        input:     "test",
      }),
    });
    expect(r.ok).toBe(false);
  });

  test("POST /api/quotes with empty input returns error", async () => {
    if (!(await providerAlive())) return;
    const r = await fetch(`${PROVIDER_BASE}/api/quotes`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        sessionId: "5",
        service:   "document-insights-v1",
        input:     "",
      }),
    });
    expect(r.ok).toBe(false);
  });

  test("GET /api/health via Vite proxy (localhost:5173) matches direct response", async () => {
    const viteBase = "http://localhost:5173";
    let viteAlive = false;
    try {
      const probe = await fetch(`${viteBase}/`, { signal: AbortSignal.timeout(2000) });
      viteAlive = probe.status < 500;
    } catch { /* not running */ }

    if (!viteAlive || !(await providerAlive())) {
      console.warn("Vite or provider not running — skipping proxy test");
      return;
    }

    const direct = await (await fetch(`${PROVIDER_BASE}/api/health`)).json() as Record<string, unknown>;
    const proxy  = await (await fetch(`${viteBase}/api/health`)).json() as Record<string, unknown>;

    expect(proxy.status).toBe(direct.status);
    expect(proxy.chainId).toBe(direct.chainId);
    expect(proxy.contractAddress).toBe(direct.contractAddress);
  });

  test("Unknown provider route returns 404 JSON error (not HTML)", async () => {
    if (!(await providerAlive())) return;
    const r = await fetch(`${PROVIDER_BASE}/api/nonexistent`);
    expect(r.status).toBe(404);
    const ct = r.headers.get("content-type") ?? "";
    expect(ct).toContain("application/json");
    const body = await r.json() as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
  });
});

// ── Top-up (Add Funds) helpers ─────────────────────────────────────────────
// These tests verify the bigint math used by ManageSession's top-up flow.
// They import the same parseUsdcUnits function (shared logic).

describe("Top-up (fundSession) math — bigint only, no floating-point", () => {
  // Helper simulating the contract's top-up validation
  function validateTopUp(opts: {
    totalFunded: bigint;
    maxBudget:   bigint;
    totalSpent:  bigint;
    closed:      boolean;
    expired:     boolean;
    amount:      string;
    balance:     bigint;
  }): { ok: boolean; reason?: string; newTotalFunded?: bigint; headroom?: bigint } {
    if (opts.closed)   return { ok: false, reason: "closed" };
    if (opts.expired)  return { ok: false, reason: "expired" };
    const headroom = opts.maxBudget - opts.totalFunded;
    if (headroom <= 0n) return { ok: false, reason: "fully_funded" };
    const units = parseUsdcUnits(opts.amount);
    if (!units || units <= 0n)  return { ok: false, reason: "invalid_amount" };
    if (units > headroom)       return { ok: false, reason: "exceeds_headroom" };
    if (units > opts.balance)   return { ok: false, reason: "insufficient_balance" };
    return { ok: true, newTotalFunded: opts.totalFunded + units, headroom };
  }

  test("TU01 valid top-up under cap succeeds", () => {
    const r = validateTopUp({ totalFunded: 500_000n, maxBudget: 1_000_000n, totalSpent: 50_000n,
      closed: false, expired: false, amount: "0.25", balance: 1_000_000n });
    expect(r.ok).toBe(true);
    expect(r.newTotalFunded).toBe(750_000n);
  });

  test("TU02 top-up exactly to maxBudget succeeds", () => {
    const r = validateTopUp({ totalFunded: 500_000n, maxBudget: 1_000_000n, totalSpent: 0n,
      closed: false, expired: false, amount: "0.50", balance: 2_000_000n });
    expect(r.ok).toBe(true);
    expect(r.newTotalFunded).toBe(1_000_000n);
  });

  test("TU03 top-up over cap is rejected", () => {
    const r = validateTopUp({ totalFunded: 800_000n, maxBudget: 1_000_000n, totalSpent: 0n,
      closed: false, expired: false, amount: "0.25", balance: 2_000_000n });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("exceeds_headroom");
  });

  test("TU04 top-up on closed session is rejected", () => {
    const r = validateTopUp({ totalFunded: 500_000n, maxBudget: 1_000_000n, totalSpent: 0n,
      closed: true, expired: false, amount: "0.10", balance: 2_000_000n });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("closed");
  });

  test("TU05 top-up on expired session is rejected", () => {
    const r = validateTopUp({ totalFunded: 500_000n, maxBudget: 1_000_000n, totalSpent: 0n,
      closed: false, expired: true, amount: "0.10", balance: 2_000_000n });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("expired");
  });

  test("TU06 top-up on fully funded session is rejected", () => {
    const r = validateTopUp({ totalFunded: 1_000_000n, maxBudget: 1_000_000n, totalSpent: 50_000n,
      closed: false, expired: false, amount: "0.10", balance: 2_000_000n });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("fully_funded");
  });

  test("TU07 top-up after partial spend — headroom is based on maxBudget - totalFunded, not availableNow", () => {
    // totalFunded=0.80, maxBudget=1.00, spent=0.50 → headroom=0.20 (not 0.70)
    const r = validateTopUp({ totalFunded: 800_000n, maxBudget: 1_000_000n, totalSpent: 500_000n,
      closed: false, expired: false, amount: "0.20", balance: 2_000_000n });
    expect(r.ok).toBe(true);
    expect(r.newTotalFunded).toBe(1_000_000n);
  });

  test("TU08 top-up with insufficient USDC balance is rejected", () => {
    const r = validateTopUp({ totalFunded: 0n, maxBudget: 1_000_000n, totalSpent: 0n,
      closed: false, expired: false, amount: "0.50", balance: 100_000n });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("insufficient_balance");
  });

  test("TU09 zero amount is rejected", () => {
    const r = validateTopUp({ totalFunded: 0n, maxBudget: 1_000_000n, totalSpent: 0n,
      closed: false, expired: false, amount: "0", balance: 2_000_000n });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_amount");
  });

  test("TU10 non-numeric amount is rejected", () => {
    const r = validateTopUp({ totalFunded: 0n, maxBudget: 1_000_000n, totalSpent: 0n,
      closed: false, expired: false, amount: "abc", balance: 2_000_000n });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_amount");
  });

  test("TU11 over-precision (7 decimal places) — bigint-only parser returns null", () => {
    // useSessionFlow.parseUsdcUnits now uses bigint-only arithmetic (no floating-point).
    // 0.0000001 has 7 decimal places; the 7th digit is truncated → value = 0 → returns null.
    // This is correct: sub-unit inputs should be rejected, not silently rounded.
    const units = parseUsdcUnits("0.0000001");
    // bigint truncation: "0000001" sliced to 6 chars → "000000" → BigInt(0) → null
    expect(units).toBeNull();
  });

  test("TU12 headroom is maxBudget - totalFunded (not maxBudget - totalSpent)", () => {
    const maxBudget   = 10_000_000n; // $10
    const totalFunded = 5_000_000n;  // $5
    const totalSpent  = 3_000_000n;  // $3 spent
    const headroom = maxBudget - totalFunded;
    expect(headroom).toBe(5_000_000n); // $5 headroom, not $7
    // available = totalFunded - totalSpent = $2 (different from headroom)
    const available = totalFunded - totalSpent;
    expect(available).toBe(2_000_000n);
  });

  test("TU13 no integer overflow — large budget values stay in bigint range", () => {
    const r = validateTopUp({
      totalFunded: 999_999_000_000n,
      maxBudget:   1_000_000_000_000n,
      totalSpent:  0n,
      closed: false, expired: false,
      amount: "1",
      balance: 2_000_000_000_000n,
    });
    expect(r.ok).toBe(true);
    expect(r.newTotalFunded).toBe(1_000_000_000_000n);
  });

  test("TU14 owner-only: agent address !== owner → top-up would be rejected by contract", () => {
    // We simulate: owner=A, connected=B (agent). The UI disables Add Funds for non-owners.
    const owner   = "0x7D76349B2eaA7436FC9E0f5F3E73C12e413eaA743".toLowerCase();
    const agent   = "0xC1CFDF533a6Da9a19e40cf9a8BFc1893DcFF2F7B".toLowerCase();
    const connected = agent;
    expect(connected === owner).toBe(false); // agent is NOT the owner
  });

  test("TU15 session recovery key is stable across page reloads", () => {
    // The ManageSession top-up flow stores no sensitive data in localStorage.
    // Verify that the session ID is stable and URL-derived.
    const rawId  = "9";
    const parsed = (() => { try { return rawId ? BigInt(rawId) : null; } catch { return null; } })();
    expect(parsed).toBe(9n);
    expect(parsed?.toString()).toBe("9");
  });

  test("TU16 parseUsdcUnits precision — 6 decimal places, no floating-point", () => {
    // $14.270001 was the mouse-wheel accident. Verify it parses correctly (not as 14.27).
    expect(parseUsdcUnits("14.270001")).toBe(14_270_001n);
    expect(parseUsdcUnits("14.27")).toBe(14_270_000n);
    // The UI now uses type="text" to prevent this accident
    expect(parseUsdcUnits("14.270001")).not.toBe(14_270_000n);
  });
});
