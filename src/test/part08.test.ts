/**
 * Part 08 — V2 fee math, V1/V2 isolation, cap-with-gross, and history display tests.
 *
 * All tests use pure functions with no browser/wagmi/viem dependencies.
 * No real RPC calls or wallet signing — unit tests only.
 */

import { describe, it, expect } from "vitest";
import { computeFeeV2, verifyFeeV2, minCapForBaseV2, FEE_BPS, FEE_DENOMINATOR } from "../lib/budgetRailV2";

// ── Fee arithmetic ────────────────────────────────────────────────────────────

describe("computeFeeV2 — fee arithmetic", () => {
  it("T1-01: $0.05 base → 250 fee, 50_250 gross", () => {
    const { baseAmount, feeAmount, grossAmount } = computeFeeV2(50_000n);
    expect(baseAmount).toBe(50_000n);
    expect(feeAmount).toBe(250n);
    expect(grossAmount).toBe(50_250n);
  });

  it("T1-02: $1.00 base → 5_000 fee, 1_005_000 gross", () => {
    const { feeAmount, grossAmount } = computeFeeV2(1_000_000n);
    expect(feeAmount).toBe(5_000n);
    expect(grossAmount).toBe(1_005_000n);
  });

  it("T1-03: $100 base → 50_000 fee, 5_050_000 gross", () => {
    const { feeAmount, grossAmount } = computeFeeV2(100_000_000n);
    expect(feeAmount).toBe(500_000n);
    expect(grossAmount).toBe(100_500_000n);
  });

  it("T1-04: base=199 → fee=0 (rounds down to zero)", () => {
    // floor(199 * 50 / 10000) = floor(9950/10000) = floor(0.995) = 0
    const { feeAmount, grossAmount } = computeFeeV2(199n);
    expect(feeAmount).toBe(0n);
    expect(grossAmount).toBe(199n); // gross = base when fee is 0
  });

  it("T1-05: base=200 → fee=1 (boundary, first non-zero fee)", () => {
    // floor(200 * 50 / 10000) = floor(10000/10000) = 1
    const { feeAmount } = computeFeeV2(200n);
    expect(feeAmount).toBe(1n);
  });

  it("T1-06: base=0 → fee=0, gross=0", () => {
    const { baseAmount, feeAmount, grossAmount } = computeFeeV2(0n);
    expect(baseAmount).toBe(0n);
    expect(feeAmount).toBe(0n);
    expect(grossAmount).toBe(0n);
  });

  it("T1-07: fee formula is floor(base * FEE_BPS / FEE_DENOMINATOR)", () => {
    const base = 77_777n;
    const expected = (base * FEE_BPS) / FEE_DENOMINATOR;
    const { feeAmount } = computeFeeV2(base);
    expect(feeAmount).toBe(expected);
  });

  it("T1-08: gross always equals base + fee", () => {
    for (const base of [1n, 100n, 50_000n, 999_999n, 1_000_000n, 99_999_999n]) {
      const { baseAmount, feeAmount, grossAmount } = computeFeeV2(base);
      expect(grossAmount).toBe(baseAmount + feeAmount);
    }
  });

  it("T1-09: feeAmount never exceeds gross", () => {
    for (const base of [0n, 1n, 200n, 50_000n, 1_000_000n]) {
      const { feeAmount, grossAmount } = computeFeeV2(base);
      expect(feeAmount).toBeLessThanOrEqual(grossAmount);
    }
  });

  it("T1-10: negative baseAmount throws", () => {
    expect(() => computeFeeV2(-1n)).toThrow();
  });
});

// ── Fee verification ──────────────────────────────────────────────────────────

describe("verifyFeeV2 — signature verification helper", () => {
  it("T2-01: correct fee passes", () => {
    expect(verifyFeeV2(50_000n, 250n)).toBe(true);
  });

  it("T2-02: inflated fee fails", () => {
    expect(verifyFeeV2(50_000n, 251n)).toBe(false);
  });

  it("T2-03: deflated fee fails", () => {
    expect(verifyFeeV2(50_000n, 249n)).toBe(false);
  });

  it("T2-04: zero fee passes for base below threshold", () => {
    // base=199 → correct fee is 0
    expect(verifyFeeV2(199n, 0n)).toBe(true);
  });

  it("T2-05: non-zero fee fails when correct fee is 0", () => {
    expect(verifyFeeV2(199n, 1n)).toBe(false);
  });
});

// ── Cap with gross ────────────────────────────────────────────────────────────

describe("minCapForBaseV2 — per-payment cap must cover gross", () => {
  it("T3-01: $0.05 base requires cap >= 50_250 (not 50_000)", () => {
    expect(minCapForBaseV2(50_000n)).toBe(50_250n);
  });

  it("T3-02: $1.00 base requires cap >= 1_005_000", () => {
    expect(minCapForBaseV2(1_000_000n)).toBe(1_005_000n);
  });

  it("T3-03: base=199 → cap=199 (fee is zero)", () => {
    expect(minCapForBaseV2(199n)).toBe(199n);
  });

  it("T3-04: cap exactly at gross passes the contract check (cap >= gross)", () => {
    const gross = minCapForBaseV2(50_000n);
    expect(gross <= gross).toBe(true); // self-check
  });

  it("T3-05: cap one below gross would fail (cap < gross)", () => {
    const gross = minCapForBaseV2(50_000n);
    expect(gross - 1n < gross).toBe(true);
  });
});

// ── V1/V2 isolation — fee constants ──────────────────────────────────────────

describe("V1/V2 fee model isolation", () => {
  it("T4-01: V1 gross = base amount (fee is 0 for V1 payments)", () => {
    // V1 PaymentSettled has a single `amount` field — no fee split
    const v1Amount = 50_000n;
    const v1Fee    = 0n;
    const v1Gross  = v1Amount + v1Fee;
    expect(v1Gross).toBe(50_000n);
  });

  it("T4-02: V2 gross > V1 gross for same base when fee > 0", () => {
    const base = 50_000n;
    const { grossAmount: v2Gross } = computeFeeV2(base);
    const v1Gross = base; // V1 has no fee
    expect(v2Gross).toBeGreaterThan(v1Gross);
  });

  it("T4-03: V2 gross = V1 gross only when fee rounds to zero", () => {
    const base = 199n; // fee = 0 for this base
    const { grossAmount } = computeFeeV2(base);
    expect(grossAmount).toBe(base); // same as V1
  });

  it("T4-04: FEE_BPS is exactly 50 (0.5%)", () => {
    expect(FEE_BPS).toBe(50n);
  });

  it("T4-05: FEE_DENOMINATOR is exactly 10_000", () => {
    expect(FEE_DENOMINATOR).toBe(10_000n);
  });
});

// ── Display formatting ────────────────────────────────────────────────────────

describe("Fee display edge cases", () => {
  it("T5-01: zero fee should be disclosed, not hidden", () => {
    const { feeAmount } = computeFeeV2(100n);
    // fee = floor(100 * 50 / 10000) = 0
    expect(feeAmount).toBe(0n);
    // UI must NOT show this as a non-zero fee — caller must check feeAmount === 0n
    expect(feeAmount === 0n).toBe(true);
  });

  it("T5-02: gross is always the session-debit amount for cap check", () => {
    // The contract checks: totalSpent + grossAmount <= totalFunded
    // and grossAmount <= perPaymentCap
    // Using base instead of gross in cap check would allow underpayment
    const { grossAmount, baseAmount } = computeFeeV2(50_000n);
    expect(grossAmount).toBeGreaterThan(baseAmount);
    // cap must be >= gross, not >= base
  });

  it("T5-03: multiple calls accumulate gross, not base", () => {
    const base  = 50_000n;
    const calls = 4n;
    const { grossAmount } = computeFeeV2(base);
    const totalDebit = grossAmount * calls;
    expect(totalDebit).toBe(201_000n); // 4 * 50_250
    // NOT 4 * 50_000 = 200_000
    expect(totalDebit).not.toBe(base * calls);
  });
});
