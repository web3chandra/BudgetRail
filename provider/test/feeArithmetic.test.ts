/**
 * Part 05 — Fee arithmetic unit tests.
 *
 * Validates that computeV2Fee() in provider/src/lib/eip712.ts matches the
 * BudgetRailV2.sol formula: feeAmount = floor(baseAmount * 50 / 10_000).
 * All values are bigint — no floating-point arithmetic ever.
 *
 * These tests run in bun test and cover:
 *   - Standard case ($0.05)
 *   - Boundary: base=199 → fee=0
 *   - Boundary: base=200 → fee=1
 *   - Boundary: base=201 → fee=1
 *   - Non-trivial rounding: 333_333 → floor(1666.665) = 1666
 *   - Large value: 10^15 base units
 *   - Zero base → zero fee, zero gross
 *   - grossAmount = baseAmount + feeAmount invariant (fuzz)
 *   - fee is always <= baseAmount * 50 / 10_000 (floor, no rounding up)
 */

import { describe, test, expect } from "bun:test";
import { computeV2Fee } from "../src/lib/eip712.js";

describe("computeV2Fee — fee arithmetic (Part 05)", () => {
  // ── Standard cases ──────────────────────────────────────────────────────────

  test("base=50_000 ($0.05): fee=250, gross=50_250", () => {
    const { feeAmount, grossAmount } = computeV2Fee(50_000n);
    expect(feeAmount).toBe(250n);
    expect(grossAmount).toBe(50_250n);
  });

  test("base=1_000_000 ($1.00): fee=5_000, gross=1_005_000", () => {
    const { feeAmount, grossAmount } = computeV2Fee(1_000_000n);
    expect(feeAmount).toBe(5_000n);
    expect(grossAmount).toBe(1_005_000n);
  });

  test("base=100_000_000 ($100): fee=500_000, gross=100_500_000", () => {
    const { feeAmount, grossAmount } = computeV2Fee(100_000_000n);
    expect(feeAmount).toBe(500_000n);
    expect(grossAmount).toBe(100_500_000n);
  });

  // ── Micro-payment / zero-fee boundary ───────────────────────────────────────

  test("base=199: fee=0 (floor(199*50/10000)=0, no treasury transfer)", () => {
    const { feeAmount, grossAmount } = computeV2Fee(199n);
    expect(feeAmount).toBe(0n);
    expect(grossAmount).toBe(199n);
  });

  test("base=200: fee=1 (200*50/10000=1 exactly)", () => {
    const { feeAmount, grossAmount } = computeV2Fee(200n);
    expect(feeAmount).toBe(1n);
    expect(grossAmount).toBe(201n);
  });

  test("base=201: fee=1 (floor(201*50/10000)=floor(1.005)=1)", () => {
    const { feeAmount, grossAmount } = computeV2Fee(201n);
    expect(feeAmount).toBe(1n);
    expect(grossAmount).toBe(202n);
  });

  test("base=0: fee=0, gross=0 (zero-amount guard: ZeroAmount in contract)", () => {
    const { feeAmount, grossAmount } = computeV2Fee(0n);
    expect(feeAmount).toBe(0n);
    expect(grossAmount).toBe(0n);
  });

  // ── Rounding (floor, never ceiling) ─────────────────────────────────────────

  test("base=333_333: fee=floor(1666.665)=1666, gross=334_999", () => {
    const { feeAmount, grossAmount } = computeV2Fee(333_333n);
    expect(feeAmount).toBe(1_666n);
    expect(grossAmount).toBe(334_999n);
  });

  test("base=1: fee=0 (floor(0.005)=0)", () => {
    const { feeAmount, grossAmount } = computeV2Fee(1n);
    expect(feeAmount).toBe(0n);
    expect(grossAmount).toBe(1n);
  });

  test("base=9_999: fee=49 (9999*50=499950; 499950/10000=49 integer div), no float", () => {
    // 9999 * 50 = 499_950; 499_950 / 10_000 = 49 (bigint truncation)
    const { feeAmount, grossAmount } = computeV2Fee(9_999n);
    expect(feeAmount).toBe(49n);
    expect(grossAmount).toBe(10_048n);
  });

  // ── Large values (no overflow up to uint128) ─────────────────────────────────

  test("base=10^15 (large): fee=5*10^12, gross=1.005*10^15", () => {
    const base = 1_000_000_000_000_000n; // 10^15
    const { feeAmount, grossAmount } = computeV2Fee(base);
    expect(feeAmount).toBe(5_000_000_000_000n);
    expect(grossAmount).toBe(1_005_000_000_000_000n);
  });

  // ── Invariant: grossAmount = baseAmount + feeAmount ───────────────────────────

  test("grossAmount == baseAmount + feeAmount for all sample values", () => {
    const bases = [0n, 1n, 199n, 200n, 201n, 333_333n, 50_000n, 1_000_000n, 1_000_000_000n];
    for (const base of bases) {
      const { feeAmount, grossAmount } = computeV2Fee(base);
      expect(grossAmount).toBe(base + feeAmount);
    }
  });

  // ── Invariant: fee is always integer floor (never rounds up) ─────────────────

  test("feeAmount never exceeds floor(base * 50 / 10_000)", () => {
    const bases = [1n, 199n, 200n, 333_333n, 50_000n, 99_999n, 1_000_000n];
    for (const base of bases) {
      const { feeAmount } = computeV2Fee(base);
      const expected = (base * 50n) / 10_000n; // bigint division truncates
      expect(feeAmount).toBe(expected);
    }
  });

  // ── No floating point: computeV2Fee must return bigints, not numbers ──────────

  test("return types are bigint, not number", () => {
    const { feeAmount, grossAmount } = computeV2Fee(50_000n);
    expect(typeof feeAmount).toBe("bigint");
    expect(typeof grossAmount).toBe("bigint");
  });

  // ── Fee is additive — C receives full base, E receives fee, vault debited gross ─

  test("C receives full base (fee is additive, not deducted from base)", () => {
    // The contract sends `baseAmount` to provider C and `feeAmount` to treasury E.
    // The vault is debited `grossAmount = base + fee`.
    // This test documents the additive model: C is not penalized.
    const base = 50_000n;
    const { feeAmount, grossAmount } = computeV2Fee(base);
    expect(grossAmount - feeAmount).toBe(base); // C receives exactly base
    expect(feeAmount).toBe(250n);               // E receives 0.5%
    expect(grossAmount).toBe(50_250n);           // vault debit = base + fee
  });

  // ── Fee-free operations: create/fund/close — zero treasury charge ────────────

  test("fee=0 when base=0 (no fee on create/fund/close — contract enforces ZeroAmount)", () => {
    // Contract has baseAmount == 0 check → revert ZeroAmount.
    // But computeV2Fee(0) itself should still return zero without crashing.
    const { feeAmount, grossAmount } = computeV2Fee(0n);
    expect(feeAmount).toBe(0n);
    expect(grossAmount).toBe(0n);
  });
});
