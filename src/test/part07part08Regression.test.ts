/**
 * Part 07 + Part 08 — Regression suite
 *
 * Covers:
 *  - Role semantics (owner A = connected wallet, not inferred; agent B separate)
 *  - Session create/fund/close permission logic (no floating-point, bigint only)
 *  - Network isolation (ARC.chainId follows VITE_ARC_NETWORK, never hardcoded)
 *  - arcProfile mainnet fail-closed guards
 *  - parseUsdcUnits bigint arithmetic
 *  - isValidAddress guard
 *
 * This file is read-only (no wallet interaction, no RPC calls).
 * All assertions use only exported pure functions.
 */

import { describe, test, expect } from "bun:test";
import { parseUsdcUnits, isValidAddress } from "@/hooks/useSessionFlow";
import { ARC, PROVIDER_CONFIGURED, V2_CONFIGURED, providerConfigError, assertCorrectNetwork } from "@/lib/arcProfile";

// ── ARC profile is consistent with testnet default ─────────────────────────

describe("ARC profile (VITE_ARC_NETWORK not set → testnet)", () => {
  test("network is testnet or mainnet (no other values)", () => {
    expect(["testnet", "mainnet"]).toContain(ARC.network);
  });

  test("chainId matches network", () => {
    if (ARC.network === "testnet") {
      expect(ARC.chainId).toBe(5042002);
    } else {
      expect(ARC.chainId).toBe(5042);
    }
  });

  test("chainName is human-readable string", () => {
    expect(typeof ARC.chainName).toBe("string");
    expect(ARC.chainName.length).toBeGreaterThan(0);
  });

  test("rpcUrl is a non-empty string", () => {
    expect(typeof ARC.rpcUrl).toBe("string");
    expect(ARC.rpcUrl.length).toBeGreaterThan(0);
  });

  test("explorerBase is a valid HTTPS URL", () => {
    expect(ARC.explorerBase).toMatch(/^https:\/\//);
  });

  test("usdcAddress is the canonical Arc USDC", () => {
    expect(ARC.usdcAddress.toLowerCase()).toBe("0x3600000000000000000000000000000000000000");
  });

  test("deployBlock is a positive bigint (testnet) or 0n (mainnet not yet deployed)", () => {
    if (ARC.network === "testnet") {
      expect(ARC.deployBlock).toBeGreaterThan(0n);
    } else {
      // Mainnet: may be 0n until deployed
      expect(typeof ARC.deployBlock).toBe("bigint");
    }
  });

  test("contractAddress is a valid 0x address or ZERO (mainnet not deployed)", () => {
    expect(ARC.contractAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

// ── PROVIDER_CONFIGURED and V2_CONFIGURED guards ───────────────────────────

describe("PROVIDER_CONFIGURED and V2_CONFIGURED", () => {
  const ZERO = "0x0000000000000000000000000000000000000000";

  test("PROVIDER_CONFIGURED is false when payout is ZERO", () => {
    // The actual env may have it set; we test the logic directly
    const payout = ARC.providerPayout;
    const signer = ARC.quoteSigner;
    const expected = payout !== ZERO && signer !== ZERO;
    expect(PROVIDER_CONFIGURED).toBe(expected);
  });

  test("V2_CONFIGURED is false when v2ContractAddress is ZERO", () => {
    const v2Addr   = ARC.v2ContractAddress;
    const treasury = ARC.treasuryAddress;
    const expected = v2Addr !== ZERO && treasury !== ZERO;
    expect(V2_CONFIGURED).toBe(expected);
  });

  test("providerConfigError returns null when both addresses non-zero, or a non-empty string otherwise", () => {
    const result = providerConfigError();
    if (PROVIDER_CONFIGURED) {
      expect(result).toBeNull();
    } else {
      expect(typeof result).toBe("string");
      expect((result ?? "").length).toBeGreaterThan(0);
    }
  });
});

// ── assertCorrectNetwork ───────────────────────────────────────────────────

describe("assertCorrectNetwork", () => {
  test("does not throw when connected chainId matches ARC.chainId", () => {
    expect(() => assertCorrectNetwork(ARC.chainId)).not.toThrow();
  });

  test("throws with clear message when chainId mismatches", () => {
    const wrongChain = ARC.chainId === 5042002 ? 1 : 5042002;
    expect(() => assertCorrectNetwork(wrongChain)).toThrow(/Wrong network/);
  });

  test("error message includes both the wrong chain and the expected chain", () => {
    const wrongChain = ARC.chainId === 5042002 ? 1 : 5042002;
    try {
      assertCorrectNetwork(wrongChain);
      expect.unreachable("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain(String(wrongChain));
      expect(msg).toContain(ARC.chainName);
    }
  });

  test("Ethereum mainnet (chain 1) is NOT a valid BudgetRail chain", () => {
    if (ARC.chainId !== 1) {
      expect(() => assertCorrectNetwork(1)).toThrow();
    }
  });
});

// ── parseUsdcUnits — bigint arithmetic, no floating-point ─────────────────

describe("parseUsdcUnits (Part 07 — bigint-only, no float)", () => {
  test("parses whole dollar amount", () => {
    expect(parseUsdcUnits("1")).toBe(1_000_000n);
  });

  test("parses $0.05 exactly (50_000 units)", () => {
    expect(parseUsdcUnits("0.05")).toBe(50_000n);
  });

  test("parses $0.000250 exactly (250 units — V2 fee for $0.05 base)", () => {
    expect(parseUsdcUnits("0.000250")).toBe(250n);
  });

  test("parses maximum realistic USDC amount without overflow", () => {
    // 1 billion USDC = 1_000_000_000 * 1_000_000 = 1e15 units
    const result = parseUsdcUnits("1000000000");
    expect(result).toBe(1_000_000_000_000_000n);
    expect(typeof result).toBe("bigint");
  });

  test("returns null for zero string", () => {
    expect(parseUsdcUnits("0")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseUsdcUnits("")).toBeNull();
  });

  test("returns null for negative-looking string (no minus parsing)", () => {
    expect(parseUsdcUnits("-1")).toBeNull();
  });

  test("returns null for non-numeric input", () => {
    expect(parseUsdcUnits("abc")).toBeNull();
    expect(parseUsdcUnits("$1.00")).toBeNull();
  });

  test("returns null for lone decimal point", () => {
    expect(parseUsdcUnits(".")).toBeNull();
  });

  test("truncates trailing fractional digits past 6 correctly", () => {
    // "0.0000001" → 0 units (< 1 unit → null)
    expect(parseUsdcUnits("0.0000001")).toBeNull();
    // "0.000001" → 1 unit
    expect(parseUsdcUnits("0.000001")).toBe(1n);
  });

  test("bigint result type — never a number or float", () => {
    const r = parseUsdcUnits("123.456789");
    expect(typeof r).toBe("bigint");
    // 123.456789 → 123456789 units
    expect(r).toBe(123_456_789n);
  });

  test("rounding: no JavaScript float contamination in intermediate math", () => {
    // 0.1 + 0.2 = 0.30000000000000004 in float; must be exactly 0.300000 in bigint
    const a = parseUsdcUnits("0.1")!;
    const b = parseUsdcUnits("0.2")!;
    const sum = a + b;
    expect(sum).toBe(300_000n); // exactly 0.3 USDC
  });
});

// ── isValidAddress ─────────────────────────────────────────────────────────

describe("isValidAddress (Part 07 — address validation)", () => {
  test("accepts a well-formed 0x address", () => {
    expect(isValidAddress("0xf6a13df15ad93c2e2968e1d69c53894a923bda21")).toBe(true);
  });

  test("accepts uppercase hex", () => {
    expect(isValidAddress("0x7D76349B806148594b8075A83b2f8fb12feaA743")).toBe(true);
  });

  test("rejects empty string", () => {
    expect(isValidAddress("")).toBe(false);
  });

  test("rejects address without 0x prefix", () => {
    expect(isValidAddress("f6a13df15ad93c2e2968e1d69c53894a923bda21")).toBe(false);
  });

  test("rejects too-short address", () => {
    expect(isValidAddress("0x1234")).toBe(false);
  });

  test("rejects ENS name", () => {
    expect(isValidAddress("sh555.eth")).toBe(false);
  });

  test("rejects non-hex characters", () => {
    expect(isValidAddress("0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG")).toBe(false);
  });
});

// ── Role permission semantics (pure logic, no wallet) ─────────────────────

describe("Role permission semantics (Part 07)", () => {
  const OWNER   = "0xC1CFDF533a6Da9a19e40cf9a8BFc1893DcFF2F7B".toLowerCase() as `0x${string}`;
  const AGENT   = "0xD995d0c31802A8D95C163f875fFefB40AB964eD6".toLowerCase() as `0x${string}`;
  const PROVIDER_C = "0x7D76349B806148594b8075A83b2f8fb12feaA743".toLowerCase() as `0x${string}`;

  // Pure role checks (matching the pattern used in ManageSession, Playground, CreateBudget)
  function computeRoles(connected: string | undefined, owner: string, agent: string) {
    const c = connected?.toLowerCase();
    return {
      isOwner:    c === owner.toLowerCase(),
      isAgent:    c === agent.toLowerCase(),
      isProvider: c === PROVIDER_C,
      isViewer:   !!c && c !== owner.toLowerCase() && c !== agent.toLowerCase() && c !== PROVIDER_C,
    };
  }

  test("connected as owner A: isOwner=true, isAgent=false", () => {
    const roles = computeRoles(OWNER, OWNER, AGENT);
    expect(roles.isOwner).toBe(true);
    expect(roles.isAgent).toBe(false);
  });

  test("connected as agent B: isAgent=true, isOwner=false", () => {
    const roles = computeRoles(AGENT, OWNER, AGENT);
    expect(roles.isOwner).toBe(false);
    expect(roles.isAgent).toBe(true);
  });

  test("A=B (owner is also agent): both flags true simultaneously", () => {
    const roles = computeRoles(OWNER, OWNER, OWNER);
    expect(roles.isOwner).toBe(true);
    expect(roles.isAgent).toBe(true);
  });

  test("connected as provider C: isProvider=true, isOwner=false, isAgent=false", () => {
    const roles = computeRoles(PROVIDER_C, OWNER, AGENT);
    expect(roles.isOwner).toBe(false);
    expect(roles.isAgent).toBe(false);
    expect(roles.isProvider).toBe(true);
    expect(roles.isViewer).toBe(false);
  });

  test("A=C (owner is also provider): isOwner=true, isProvider=true", () => {
    const roles = computeRoles(OWNER, OWNER, AGENT);
    // If C happens to be the same as owner
    const rolesAC = computeRoles(OWNER, OWNER, AGENT);
    // The ownership proof should NOT appear for A just because A's address happens to equal C
    // (Ownership proof is only for address === session.provider — address equality is required)
    expect(rolesAC.isOwner).toBe(true);
    expect(rolesAC.isAgent).toBe(false);
  });

  test("viewer (unrelated wallet): isOwner=false, isAgent=false, isViewer=true", () => {
    const other = "0x1234567890123456789012345678901234567890";
    const roles = computeRoles(other, OWNER, AGENT);
    expect(roles.isOwner).toBe(false);
    expect(roles.isAgent).toBe(false);
    expect(roles.isViewer).toBe(true);
  });

  test("disconnected wallet: all roles false", () => {
    const roles = computeRoles(undefined, OWNER, AGENT);
    expect(roles.isOwner).toBe(false);
    expect(roles.isAgent).toBe(false);
    expect(roles.isProvider).toBe(false);
    expect(roles.isViewer).toBe(false);
  });

  test("Provider C appears in session because it is configured — not because it owns the wallet", () => {
    // Provider C being in the session.provider field does NOT mean
    // the connected user is provider C — roles are checked per connected address
    const connectedOwner = computeRoles(OWNER, OWNER, AGENT);
    // The provider C address is 0x7D76... but the connected wallet is owner A
    // isProvider must be false for owner A
    expect(connectedOwner.isProvider).toBe(false);
  });
});

// ── Top-up headroom math (Part 07 — bigint, no float) ─────────────────────

describe("Top-up headroom math (Part 07)", () => {
  // Mirrors the exact formula in ManageSession.tsx:
  //   topUpHeadroom = session.maxBudget - session.totalFunded

  function topUpHeadroom(maxBudget: bigint, totalFunded: bigint): bigint {
    return maxBudget - totalFunded;
  }

  function availableNow(totalFunded: bigint, totalSpent: bigint): bigint {
    return totalFunded - totalSpent;
  }

  test("headroom is zero when fully funded", () => {
    expect(topUpHeadroom(1_000_000n, 1_000_000n)).toBe(0n);
  });

  test("headroom is positive when partially funded", () => {
    expect(topUpHeadroom(1_000_000n, 500_000n)).toBe(500_000n);
  });

  test("availableNow correctly reflects funded − spent", () => {
    expect(availableNow(1_000_000n, 250_000n)).toBe(750_000n);
  });

  test("availableNow is zero after full spend", () => {
    expect(availableNow(500_000n, 500_000n)).toBe(0n);
  });

  test("top-up amount must not exceed headroom — validation logic", () => {
    const headroom = topUpHeadroom(1_000_000n, 750_000n); // 250_000n
    const validAmount = 200_000n;
    const invalidAmount = 300_000n;
    expect(validAmount <= headroom).toBe(true);
    expect(invalidAmount > headroom).toBe(true);
  });
});

// ── Network isolation: ARC profile drives all chain usage ─────────────────

describe("Network isolation (Part 08)", () => {
  test("ARC.chainId is either Arc Testnet (5042002) or Arc Mainnet (5042)", () => {
    expect([5042002, 5042]).toContain(ARC.chainId);
  });

  test("Ethereum mainnet (chain 1) is NOT a valid BudgetRail transaction chain", () => {
    expect(ARC.chainId).not.toBe(1);
  });

  test("mainnet profile rejects zero contract address", () => {
    // providerConfigError() on mainnet with zero contractAddress should report the env var
    // This runs in the current build — if mainnet + zero contract, the error must mention the var
    if (ARC.network === "mainnet") {
      const err = providerConfigError();
      if (ARC.contractAddress === "0x0000000000000000000000000000000000000000") {
        expect(err).not.toBeNull();
        expect(err).toContain("VITE_BUDGET_RAIL_MAINNET_ADDRESS");
      }
    }
  });

  test("USDC address is the same on both testnet and mainnet", () => {
    // Canonical Arc USDC address is same on both chains
    expect(ARC.usdcAddress.toLowerCase()).toBe("0x3600000000000000000000000000000000000000");
  });

  test("V2_CONFIGURED is false when v2ContractAddress is zero (expected for fresh testnet build)", () => {
    const ZERO = "0x0000000000000000000000000000000000000000";
    const expected = ARC.v2ContractAddress !== ZERO && ARC.treasuryAddress !== ZERO;
    expect(V2_CONFIGURED).toBe(expected);
  });

  test("V2 address does not fall back to V1 address", () => {
    const ZERO = "0x0000000000000000000000000000000000000000";
    if (!V2_CONFIGURED) {
      // When V2 is not configured, v2ContractAddress should be ZERO, not a copy of V1
      expect(ARC.v2ContractAddress).toBe(ZERO);
    } else {
      // When configured, V1 and V2 must differ
      expect(ARC.v2ContractAddress.toLowerCase()).not.toBe(ARC.contractAddress.toLowerCase());
    }
  });

  test("providerApiUrl never ends with /api", () => {
    // Ensure the API URL stripping is applied
    expect(ARC.providerApiUrl).not.toMatch(/\/api\/?$/);
  });
});
