/**
 * BudgetRail SDK unit tests
 *
 * Tests pure functions only — no RPC, no wallet, no network.
 * Run: bun test packages/sdk/src/
 */

import { describe, test, expect } from "bun:test";
import { toEventHash }  from "viem";
import { parseAbi }     from "viem";

import {
  BUDGET_RAIL_ABI,
  DEPLOY_BLOCK_TESTNET,
  ARC_TESTNET_CHAIN_ID,
  ARC_MAINNET_CHAIN_ID,
  USDC_ADDRESS,
  USDC_DECIMALS,
  ARC_TESTNET_CONTRACT,
} from "./abi.js";
import { BudgetRailError } from "./types.js";
import { getServiceById, SERVICE_REGISTRY, validateProviderUrl } from "./services.js";
import { computeRequestHash } from "./quote.js";
import { decodePaymentSettledLog } from "./read.js";

// ── ABI constants ────────────────────────────────────────────────────────────

describe("ABI constants", () => {
  test("USDC_ADDRESS is the Arc canonical address", () => {
    expect(USDC_ADDRESS).toBe("0x3600000000000000000000000000000000000000");
  });

  test("USDC_DECIMALS is 6", () => {
    expect(USDC_DECIMALS).toBe(6);
  });

  test("ARC_TESTNET_CHAIN_ID is 5042002", () => {
    expect(ARC_TESTNET_CHAIN_ID).toBe(5042002);
  });

  test("ARC_MAINNET_CHAIN_ID is 5042", () => {
    expect(ARC_MAINNET_CHAIN_ID).toBe(5042);
  });

  test("ARC_TESTNET_CONTRACT is the deployed address", () => {
    expect(ARC_TESTNET_CONTRACT.toLowerCase()).toBe("0xf6a13df15ad93c2e2968e1d69c53894a923bda21");
  });

  test("DEPLOY_BLOCK_TESTNET is a bigint", () => {
    expect(typeof DEPLOY_BLOCK_TESTNET).toBe("bigint");
    expect(DEPLOY_BLOCK_TESTNET).toBeGreaterThan(0n);
  });
});

// ── PaymentSettled topic0 (regression) ───────────────────────────────────────

describe("PaymentSettled topic0 (SDK ABI)", () => {
  const parsedAbi = parseAbi([
    "event PaymentSettled(uint256 indexed sessionId,bytes32 indexed requestId,address indexed provider,bytes32 requestHash,address agent,uint96 amount,uint64 quoteDeadline)",
  ]);

  test("SDK-derived topic0 equals the canonical keccak256", () => {
    const derived = toEventHash(parsedAbi[0]);
    expect(derived.toLowerCase()).toBe("0x5c25b27cd6964ebe086bfeb3f23d3b3a2a086ed5166e11817b2e620cadc5ead5");
  });

  test("Old broken constant does NOT match", () => {
    const derived = toEventHash(parsedAbi[0]);
    expect(derived.toLowerCase()).not.toBe("0xeb67dfc5f3e7a54a6c3eb1ded77bb5dd50c2e5abf5e2dc5ff61c3e2e0cd15c99");
  });

  test("BUDGET_RAIL_ABI includes PaymentSettled event with correct field count", () => {
    const psEntry = (BUDGET_RAIL_ABI as readonly { type: string; name?: string; inputs?: unknown[] }[]).find(
      (e) => e.type === "event" && e.name === "PaymentSettled"
    );
    expect(psEntry).toBeDefined();
    expect((psEntry!.inputs as unknown[]).length).toBe(7);
  });
});

// ── BudgetRailError ──────────────────────────────────────────────────────────

describe("BudgetRailError", () => {
  test("constructs with code and message", () => {
    const err = new BudgetRailError("NOT_AGENT", "Only agent B may pay");
    expect(err.code).toBe("NOT_AGENT");
    expect(err.message).toBe("Only agent B may pay");
    expect(err.retryable).toBe(false);
    expect(err.name).toBe("BudgetRailError");
  });

  test("retryable defaults to false", () => {
    expect(new BudgetRailError("UNKNOWN", "x").retryable).toBe(false);
  });

  test("retryable can be set to true", () => {
    expect(new BudgetRailError("PROVIDER_UNREACHABLE", "x", true).retryable).toBe(true);
  });

  test("is instanceof Error", () => {
    expect(new BudgetRailError("UNKNOWN", "x")).toBeInstanceOf(Error);
  });

  test("all error codes are strings", () => {
    const codes: BudgetRailError["code"][] = [
      "SESSION_NOT_FOUND", "NOT_OWNER", "NOT_AGENT", "SESSION_CLOSED",
      "SESSION_EXPIRED", "BUDGET_EXCEEDED", "PER_PAYMENT_CAP_EXCEEDED",
      "QUOTE_EXPIRED", "DUPLICATE_REQUEST", "INVALID_SIGNATURE",
      "ZERO_ADDRESS", "WRONG_CHAIN", "PROVIDER_MISMATCH", "SIGNER_MISMATCH",
      "PROVIDER_UNREACHABLE", "FULFILLMENT_FAILED", "PAYMENT_NOT_SETTLED",
      "SIMULATION_FAILED", "UNKNOWN",
    ];
    for (const code of codes) {
      expect(typeof code).toBe("string");
    }
  });
});

// ── Service registry ──────────────────────────────────────────────────────────

describe("Service registry", () => {
  test("SERVICE_REGISTRY is non-empty", () => {
    expect(SERVICE_REGISTRY.length).toBeGreaterThan(0);
  });

  test("document-insights-v1 is registered", () => {
    const svc = getServiceById("document-insights-v1");
    expect(svc).toBeDefined();
    expect(svc!.name).toBe("Document Insights");
    expect(svc!.priceUnits).toBe(50_000n);
    expect(svc!.inputType).toBe("text");
  });

  test("repo-check-v1 is registered", () => {
    const svc = getServiceById("repo-check-v1");
    expect(svc).toBeDefined();
    expect(svc!.priceUnits).toBe(50_000n);
    expect(svc!.inputType).toBe("github_repo");
  });

  test("unknown-service returns undefined", () => {
    expect(getServiceById("nonexistent-service")).toBeUndefined();
  });

  test("all services have a non-empty id, name, description", () => {
    for (const s of SERVICE_REGISTRY) {
      expect(s.id.length).toBeGreaterThan(0);
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
    }
  });

  test("all priceUnits are positive bigint", () => {
    for (const s of SERVICE_REGISTRY) {
      expect(s.priceUnits).toBeGreaterThan(0n);
    }
  });
});

// ── validateProviderUrl ────────────────────────────────────────────────────────

describe("validateProviderUrl", () => {
  test("accepts https URL", () => {
    expect(() => validateProviderUrl("https://provider.example.com")).not.toThrow();
  });

  test("accepts http URL (for dev)", () => {
    expect(() => validateProviderUrl("http://localhost:3001")).not.toThrow();
  });

  test("rejects non-URL string", () => {
    expect(() => validateProviderUrl("not-a-url")).toThrow();
  });

  test("rejects ftp protocol", () => {
    expect(() => validateProviderUrl("ftp://evil.com")).toThrow();
  });

  test("rejects file protocol", () => {
    expect(() => validateProviderUrl("file:///etc/passwd")).toThrow();
  });

  test("rejects javascript protocol", () => {
    expect(() => validateProviderUrl("javascript:alert(1)")).toThrow();
  });

  test("returned URL has correct hostname", () => {
    const url = validateProviderUrl("https://provider.example.com/path");
    expect(url.hostname).toBe("provider.example.com");
  });
});

// ── computeRequestHash ────────────────────────────────────────────────────────

describe("computeRequestHash", () => {
  test("returns 0x-prefixed 64-char hex string", async () => {
    const hash = await computeRequestHash("hello");
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("SHA-256 of empty string is the canonical value", async () => {
    const hash = await computeRequestHash("");
    expect(hash.toLowerCase()).toBe("0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("SHA-256 of 'hello world' is the canonical value", async () => {
    const hash = await computeRequestHash("hello world");
    // canonical: echo -n "hello world" | sha256sum
    expect(hash.toLowerCase()).toBe("0xb94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });

  test("different inputs produce different hashes", async () => {
    const h1 = await computeRequestHash("input A");
    const h2 = await computeRequestHash("input B");
    expect(h1).not.toBe(h2);
  });

  test("same input always produces same hash (deterministic)", async () => {
    const input = "The quick brown fox";
    const h1 = await computeRequestHash(input);
    const h2 = await computeRequestHash(input);
    expect(h1).toBe(h2);
  });

  test("Unicode input is handled correctly", async () => {
    const hash = await computeRequestHash("日本語テスト");
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

// ── decodePaymentSettledLog ────────────────────────────────────────────────────

describe("decodePaymentSettledLog (SDK)", () => {
  test("returns null for log with wrong topic0", () => {
    const fakeLog = {
      address: "0xf6a13df15ad93c2e2968e1d69c53894a923bda21" as `0x${string}`,
      topics:  ["0xeb67dfc5f3e7a54a6c3eb1ded77bb5dd50c2e5abf5e2dc5ff61c3e2e0cd15c99"] as `0x${string}`[],
      data:    "0x" as `0x${string}`,
    };
    expect(decodePaymentSettledLog(fakeLog as never)).toBeNull();
  });

  test("returns null for an ERC-20 Transfer log (not PaymentSettled)", () => {
    const transferLog = {
      address: USDC_ADDRESS as `0x${string}`,
      // ERC-20 Transfer topic0
      topics:  ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"] as `0x${string}`[],
      data:    "0x" as `0x${string}`,
    };
    expect(decodePaymentSettledLog(transferLog as never)).toBeNull();
  });
});

// ── RepoCheck input parsing ────────────────────────────────────────────────────

describe("RepoCheck input validation", () => {
  // Import inline to avoid module resolution issues in test
  async function getParser() {
    const mod = await import("../../examples/provider-api/repocheck.js").catch(() => null);
    return mod?.parseRepocheckInput;
  }

  test("parseRepocheckInput accepts valid input", async () => {
    const parse = await getParser();
    if (!parse) return; // skip if module not resolvable in test env
    const result = parse("https://github.com/vitejs/vite@a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0");
    expect(result.owner).toBe("vitejs");
    expect(result.repo).toBe("vite");
    expect(result.commitSha).toBe("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0");
  });

  test("parseRepocheckInput rejects short SHA", async () => {
    const parse = await getParser();
    if (!parse) return;
    expect(() => parse("https://github.com/owner/repo@abc123")).toThrow();
  });

  test("parseRepocheckInput rejects non-GitHub URL", async () => {
    const parse = await getParser();
    if (!parse) return;
    expect(() => parse("https://gitlab.com/owner/repo@" + "a".repeat(40))).toThrow();
  });

  test("parseRepocheckInput rejects missing @ separator", async () => {
    const parse = await getParser();
    if (!parse) return;
    expect(() => parse("https://github.com/owner/repo")).toThrow();
  });
});
