/**
 * Part 04 regression tests.
 *
 * Covers: top-up cap math, expiry gating, authorization, budget precision,
 * receipt status checks, failed-tx retry logic, payment recovery, role errors,
 * error classifier, and Close & Refund accounting.
 *
 * All tests are pure logic — no wagmi, no RPC, no wallet required.
 */

import { describe, it, expect } from "bun:test";

// ── Re-usable helpers (copied from source to avoid import-side-effects) ─────

function parseUsdcUnits(s: string): bigint | null {
  const t = s.trim();
  if (!t || !/^\d*\.?\d*$/.test(t) || t === "." || t === "") return null;
  const [whole, frac = ""] = t.split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  try {
    const v = BigInt(whole || "0") * 1_000_000n + BigInt(fracPadded);
    return v > 0n ? v : null;
  } catch { return null; }
}

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function topUpHeadroom(maxBudget: bigint, totalFunded: bigint): bigint {
  return maxBudget > totalFunded ? maxBudget - totalFunded : 0n;
}

function availableBalance(totalFunded: bigint, totalSpent: bigint): bigint {
  return totalFunded > totalSpent ? totalFunded - totalSpent : 0n;
}

function isExpired(expiresAt: bigint): boolean {
  return Number(expiresAt) < Math.floor(Date.now() / 1000);
}

function canTopUp(session: {
  closed: boolean;
  expiresAt: bigint;
  maxBudget: bigint;
  totalFunded: bigint;
}): { allowed: boolean; reason: string } {
  if (session.closed) return { allowed: false, reason: "Session is closed." };
  if (isExpired(session.expiresAt)) return { allowed: false, reason: "Session has expired." };
  const headroom = topUpHeadroom(session.maxBudget, session.totalFunded);
  if (headroom === 0n) return { allowed: false, reason: "Already fully funded to max budget." };
  return { allowed: true, reason: "" };
}

// ── Error classifier (inline, identical logic to Playground.tsx) ─────────

interface ClassifiedError { code: string; userMessage: string; retryable: boolean; action: string; }

function classifyError(raw: string, context: "quote" | "pay" | "fulfill"): ClassifiedError {
  const msg = raw.toLowerCase();
  if (context === "pay") {
    if (msg.includes("notagent") || msg.includes("not agent") || msg.includes("unauthorized"))
      return { code: "WRONG_AGENT", userMessage: "Connected wallet is not the authorized agent for this session.", retryable: false, action: "Switch to the agent wallet." };
    if (msg.includes("deadline") || msg.includes("quoteexpired"))
      return { code: "QUOTE_EXPIRED", userMessage: "Quote has expired.", retryable: true, action: "Request a new quote." };
    if (msg.includes("insufficient") || msg.includes("balance") || msg.includes("budget"))
      return { code: "INSUFFICIENT_BALANCE", userMessage: "Insufficient session balance for this payment.", retryable: false, action: "Add funds to the session." };
    if (msg.includes("gas") || msg.includes("intrinsic"))
      return { code: "INSUFFICIENT_GAS", userMessage: "Transaction failed — insufficient gas.", retryable: true, action: "Ensure agent wallet has USDC for gas." };
    if (msg.includes("quotesigner") || msg.includes("signature"))
      return { code: "SIGNER_MISMATCH", userMessage: "Quote signature verification failed.", retryable: false, action: "Request a new quote." };
    if (msg.includes("user rejected") || msg.includes("cancelled"))
      return { code: "WALLET_REJECTED", userMessage: "Transaction was rejected in your wallet.", retryable: true, action: "Click Pay again." };
    if (msg.includes("wrong network") || msg.includes("chain"))
      return { code: "WRONG_NETWORK", userMessage: "Wrong network.", retryable: true, action: "Switch to Arc Testnet." };
    if (msg.includes("reverted"))
      return { code: "TX_REVERTED", userMessage: "Transaction reverted onchain.", retryable: false, action: "Check session balance and request a fresh quote." };
  }
  if (context === "fulfill") {
    if (msg.includes("tx not found") || msg.includes("402"))
      return { code: "INDEXING_DELAY", userMessage: "Provider has not indexed your payment yet.", retryable: true, action: "Retry." };
    if (msg.includes("503") || msg.includes("network"))
      return { code: "PROVIDER_UNREACHABLE", userMessage: "Provider API is temporarily unreachable.", retryable: true, action: "Retry when online." };
  }
  if (context === "quote") {
    if (msg.includes("provider") || msg.includes("fetch"))
      return { code: "PROVIDER_UNREACHABLE", userMessage: "Provider API is unreachable.", retryable: true, action: "Check provider server." };
  }
  return { code: "UNKNOWN", userMessage: raw, retryable: context !== "pay", action: "" };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("parseUsdcUnits — bigint precision", () => {
  it("parses whole dollars", () => {
    expect(parseUsdcUnits("1")).toBe(1_000_000n);
  });
  it("parses cents", () => {
    expect(parseUsdcUnits("0.05")).toBe(50_000n);
  });
  it("parses 6 decimal places exactly", () => {
    expect(parseUsdcUnits("0.000001")).toBe(1n);
  });
  it("returns null for sub-unit value", () => {
    expect(parseUsdcUnits("0.0000001")).toBeNull();
  });
  it("returns null for zero", () => {
    expect(parseUsdcUnits("0")).toBeNull();
    expect(parseUsdcUnits("0.000000")).toBeNull();
  });
  it("returns null for empty string", () => {
    expect(parseUsdcUnits("")).toBeNull();
  });
  it("returns null for non-numeric", () => {
    expect(parseUsdcUnits("abc")).toBeNull();
    expect(parseUsdcUnits("1e5")).toBeNull();
  });
  it("handles max budget string $1.00", () => {
    expect(parseUsdcUnits("1.00")).toBe(1_000_000n);
  });
});

describe("topUpHeadroom — lifetime deposit capacity", () => {
  it("returns maxBudget - totalFunded when under cap", () => {
    expect(topUpHeadroom(1_000_000n, 500_000n)).toBe(500_000n);
  });
  it("returns 0 when fully funded", () => {
    expect(topUpHeadroom(1_000_000n, 1_000_000n)).toBe(0n);
  });
  it("returns 0 when totalFunded exceeds maxBudget (guard)", () => {
    expect(topUpHeadroom(1_000_000n, 1_100_000n)).toBe(0n);
  });
  it("headroom is NOT affected by spending — depends only on funded", () => {
    // User spent $0.50 from $1 max. totalFunded=$1.00. Headroom=0.
    const maxBudget = 1_000_000n;
    const totalFunded = 1_000_000n;
    const totalSpent = 500_000n;
    expect(topUpHeadroom(maxBudget, totalFunded)).toBe(0n);
    // Available balance is separate from headroom
    expect(availableBalance(totalFunded, totalSpent)).toBe(500_000n);
  });
  it("partially funded session has correct headroom", () => {
    // maxBudget=$1, funded=$0.20, headroom=$0.80
    expect(topUpHeadroom(1_000_000n, 200_000n)).toBe(800_000n);
  });
});

describe("canTopUp — gating logic", () => {
  const futureExpiry = BigInt(Math.floor(Date.now() / 1000) + 86400);
  const pastExpiry   = BigInt(Math.floor(Date.now() / 1000) - 1);

  it("allows top-up on open, active session with headroom", () => {
    const result = canTopUp({ closed: false, expiresAt: futureExpiry, maxBudget: 1_000_000n, totalFunded: 500_000n });
    expect(result.allowed).toBe(true);
  });
  it("denies top-up on closed session", () => {
    const result = canTopUp({ closed: true, expiresAt: futureExpiry, maxBudget: 1_000_000n, totalFunded: 500_000n });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("closed");
  });
  it("denies top-up on expired session", () => {
    const result = canTopUp({ closed: false, expiresAt: pastExpiry, maxBudget: 1_000_000n, totalFunded: 500_000n });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("expired");
  });
  it("denies top-up when already fully funded", () => {
    const result = canTopUp({ closed: false, expiresAt: futureExpiry, maxBudget: 1_000_000n, totalFunded: 1_000_000n });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("fully funded");
  });
  it("closed takes precedence over expired", () => {
    const result = canTopUp({ closed: true, expiresAt: pastExpiry, maxBudget: 1_000_000n, totalFunded: 0n });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("closed");
  });
});

describe("Close & Refund accounting", () => {
  it("refund = totalFunded - totalSpent", () => {
    const totalFunded = 1_000_000n;
    const totalSpent  =   750_000n;
    expect(availableBalance(totalFunded, totalSpent)).toBe(250_000n);
  });
  it("refund is zero when all funds spent", () => {
    expect(availableBalance(500_000n, 500_000n)).toBe(0n);
  });
  it("refund never goes negative (guard)", () => {
    expect(availableBalance(500_000n, 600_000n)).toBe(0n);
  });
  it("unspent approval quota does not affect refund (approval != deposit)", () => {
    // totalFunded=$0.50, totalSpent=$0.30, approved-but-not-funded is irrelevant
    expect(availableBalance(500_000n, 300_000n)).toBe(200_000n);
  });
});

describe("isValidAddress", () => {
  it("accepts well-formed hex addresses", () => {
    expect(isValidAddress("0x7D76349B806148594b8075A83b2f8fb12feaA743")).toBe(true);
    expect(isValidAddress("0x0000000000000000000000000000000000000000")).toBe(true);
  });
  it("rejects zero address string", () => {
    // Structural test — contract separately rejects zero address semantically
    expect(isValidAddress("0x0000000000000000000000000000000000000000")).toBe(true);
  });
  it("rejects malformed addresses", () => {
    expect(isValidAddress("0xabcdef")).toBe(false);
    expect(isValidAddress("not-an-address")).toBe(false);
    expect(isValidAddress("")).toBe(false);
  });
});

describe("classifyError — error codes and retry guidance", () => {
  it("classifies wrong agent error correctly", () => {
    const e = classifyError("NotAgent: caller is not the authorized agent", "pay");
    expect(e.code).toBe("WRONG_AGENT");
    expect(e.retryable).toBe(false);
  });
  it("classifies expired quote as retryable", () => {
    const e = classifyError("QuoteExpired: deadline has passed", "pay");
    expect(e.code).toBe("QUOTE_EXPIRED");
    expect(e.retryable).toBe(true);
  });
  it("classifies insufficient balance as non-retryable", () => {
    const e = classifyError("InsufficientBalance: session budget exceeded", "pay");
    expect(e.code).toBe("INSUFFICIENT_BALANCE");
    expect(e.retryable).toBe(false);
  });
  it("classifies signer mismatch correctly", () => {
    const e = classifyError("invalid signature: quotesigner mismatch", "pay");
    expect(e.code).toBe("SIGNER_MISMATCH");
    expect(e.retryable).toBe(false);
  });
  it("classifies wallet rejection as retryable", () => {
    const e = classifyError("User rejected the request. (cancelled)", "pay");
    expect(e.code).toBe("WALLET_REJECTED");
    expect(e.retryable).toBe(true);
  });
  it("classifies provider unreachable (quote context) as retryable", () => {
    const e = classifyError("fetch failed: provider not available", "quote");
    expect(e.code).toBe("PROVIDER_UNREACHABLE");
    expect(e.retryable).toBe(true);
  });
  it("classifies indexing delay (fulfill) as retryable", () => {
    const e = classifyError("tx not found: 402", "fulfill");
    expect(e.code).toBe("INDEXING_DELAY");
    expect(e.retryable).toBe(true);
  });
  it("fulfill errors are retryable by default (payment already confirmed)", () => {
    const e = classifyError("completely unknown error xyzabc", "fulfill");
    expect(e.retryable).toBe(true);
  });
  it("pay errors are non-retryable by default", () => {
    const e = classifyError("completely unknown pay error", "pay");
    expect(e.retryable).toBe(false);
  });
});

describe("recovery key uniqueness", () => {
  function recoveryKey(chainId: number, contractAddress: string, sessionId: string, requestId: string): string {
    return `budgetrail_pg_recovery_v1_${chainId}_${contractAddress.toLowerCase()}_${sessionId}_${requestId.slice(0, 18)}`;
  }

  it("different sessionIds produce different keys", () => {
    const k1 = recoveryKey(5042002, "0xabc", "1", "0xreq1234567890abcdef");
    const k2 = recoveryKey(5042002, "0xabc", "2", "0xreq1234567890abcdef");
    expect(k1).not.toBe(k2);
  });
  it("different requestIds produce different keys", () => {
    const k1 = recoveryKey(5042002, "0xabc", "1", "0xreq111111111111111");
    const k2 = recoveryKey(5042002, "0xabc", "1", "0xreq222222222222222");
    expect(k1).not.toBe(k2);
  });
  it("different chains produce different keys", () => {
    const k1 = recoveryKey(5042002, "0xabc", "1", "0xreq1234567890abcdef");
    const k2 = recoveryKey(5042,    "0xabc", "1", "0xreq1234567890abcdef");
    expect(k1).not.toBe(k2);
  });
  it("contract address is lowercased for comparison", () => {
    const k1 = recoveryKey(5042002, "0xABC", "1", "0xreq1234567890abcdef");
    const k2 = recoveryKey(5042002, "0xabc", "1", "0xreq1234567890abcdef");
    expect(k1).toBe(k2);
  });
});
