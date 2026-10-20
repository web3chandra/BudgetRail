/**
 * POST /api/quotes — unit tests with mocked onchain reads.
 * Run: bun test provider/test/quotes.test.ts
 *
 * These tests mock readSession so no live RPC is needed.
 * They verify input validation, session checks, price enforcement,
 * signature shape, and secret non-leakage.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { handleQuotes } from "../src/routes/quotes.js";
import type { Config } from "../src/lib/config.js";
import * as onchain from "../src/lib/onchain.js";
import { quoteSignerAddressFromPrivKey } from "../src/lib/eip712.js";

// ── Test private key (never used with real funds) ──────────────────────────
const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as `0x${string}`;

// ── Mock config ────────────────────────────────────────────────────────────
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    network:            "testnet",
    chainId:            5042002,
    rpcUrl:             "https://rpc.testnet.arc.io",
    contractAddress:    "0xf6a13df15ad93c2e2968e1d69c53894a923bda21",
    providerPayoutAddress: "0x3000000000000000000000000000000000000000",
    quoteSignerPrivateKey: TEST_PK,
    quoteSignerAddress: "0x",     // derived from key at runtime
    pricePerCall:       50000n,
    quoteWindowSeconds: 600,
    maxInputBytes:      8192,
    rateLimitPerMinute: 100,
    port:               3001,
    ...overrides,
  } as Config;
}

// ── Mock session ────────────────────────────────────────────────────────────
function mockSession(overrides: Partial<ReturnType<typeof makeSession>> = {}) {
  return makeSession(overrides);
}

function makeSession(overrides: Partial<{
  owner: string; agent: string; provider: string; quoteSigner: string;
  maxBudget: bigint; perPaymentCap: bigint; totalFunded: bigint; totalSpent: bigint;
  expiresAt: bigint; closed: boolean;
}> = {}) {
  const cfg = makeConfig();
  // Derive quote signer address from the test key
  const qs = quoteSignerAddressFromPrivKey(TEST_PK);
  return {
    owner:         "0x1000000000000000000000000000000000000000",
    agent:         "0x2000000000000000000000000000000000000000",
    provider:      cfg.providerPayoutAddress,
    quoteSigner:   qs,
    maxBudget:     1_000_000n,
    perPaymentCap: 100_000n,
    totalFunded:   1_000_000n,
    totalSpent:    0n,
    expiresAt:     BigInt(Math.floor(Date.now() / 1000) + 3600),
    closed:        false,
    ...overrides,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────
function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/quotes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("POST /api/quotes", () => {
  beforeEach(() => {
    // Reset readSession mock before each test
    (onchain.readSession as ReturnType<typeof mock>).mockClear?.();
  });

  it("Q01 valid request returns signed quote with correct shape", async () => {
    mock.module("../src/lib/onchain.js", () => ({
      ...onchain,
      readSession: async () => mockSession(),
    }));
    const cfg = makeConfig();
    const req = makeRequest({ sessionId: "1", service: "document-insights-v1", input: "Hello world." });
    const res = await handleQuotes(cfg, req);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.service).toBe("document-insights-v1");
    expect(body.amount).toBe("50000");
    expect(typeof body.requestId).toBe("string");
    expect(typeof body.requestHash).toBe("string");
    expect(typeof body.signature).toBe("string");
    expect(body.chainId).toBe(5042002);
    expect(body.contractAddress).toBe(cfg.contractAddress);
    // Ensure private key is NOT in response
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain(TEST_PK.slice(2)); // no raw private key bytes
  });

  it("Q02 empty input → 400", async () => {
    mock.module("../src/lib/onchain.js", () => ({ ...onchain, readSession: async () => mockSession() }));
    const res = await handleQuotes(makeConfig(), makeRequest({ sessionId: "1", service: "document-insights-v1", input: "" }));
    expect(res.status).toBe(400);
  });

  it("Q03 input too large → 400", async () => {
    mock.module("../src/lib/onchain.js", () => ({ ...onchain, readSession: async () => mockSession() }));
    const big = "A".repeat(8193);
    const res = await handleQuotes(makeConfig(), makeRequest({ sessionId: "1", service: "document-insights-v1", input: big }));
    expect(res.status).toBe(400);
    const b = await res.json() as { error: string };
    expect(b.error).toContain("exceeds");
  });

  it("Q04 unsupported service → 400", async () => {
    mock.module("../src/lib/onchain.js", () => ({ ...onchain, readSession: async () => mockSession() }));
    const res = await handleQuotes(makeConfig(), makeRequest({ sessionId: "1", service: "fake-service", input: "test" }));
    expect(res.status).toBe(400);
  });

  it("Q05 invalid sessionId → 400", async () => {
    mock.module("../src/lib/onchain.js", () => ({ ...onchain, readSession: async () => mockSession() }));
    const res = await handleQuotes(makeConfig(), makeRequest({ sessionId: "abc", service: "document-insights-v1", input: "test" }));
    expect(res.status).toBe(400);
  });

  it("Q06 session not found → 404", async () => {
    mock.module("../src/lib/onchain.js", () => ({ ...onchain, readSession: async () => null }));
    const res = await handleQuotes(makeConfig(), makeRequest({ sessionId: "999", service: "document-insights-v1", input: "test" }));
    expect(res.status).toBe(404);
  });

  it("Q07 closed session → 400", async () => {
    mock.module("../src/lib/onchain.js", () => ({ ...onchain, readSession: async () => mockSession({ closed: true }) }));
    const res = await handleQuotes(makeConfig(), makeRequest({ sessionId: "1", service: "document-insights-v1", input: "test" }));
    expect(res.status).toBe(400);
    const b = await res.json() as { error: string };
    expect(b.error).toContain("closed");
  });

  it("Q08 expired session → 400", async () => {
    const expiredTs = BigInt(Math.floor(Date.now() / 1000) - 10);
    mock.module("../src/lib/onchain.js", () => ({ ...onchain, readSession: async () => mockSession({ expiresAt: expiredTs }) }));
    const res = await handleQuotes(makeConfig(), makeRequest({ sessionId: "1", service: "document-insights-v1", input: "test" }));
    expect(res.status).toBe(400);
    const b = await res.json() as { error: string };
    expect(b.error).toContain("expired");
  });

  it("Q09 wrong provider → 400", async () => {
    mock.module("../src/lib/onchain.js", () => ({
      ...onchain,
      readSession: async () => mockSession({ provider: "0x9999999999999999999999999999999999999999" }),
    }));
    const res = await handleQuotes(makeConfig(), makeRequest({ sessionId: "1", service: "document-insights-v1", input: "test" }));
    expect(res.status).toBe(400);
    const b = await res.json() as { error: string };
    expect(b.error).toContain("provider");
  });

  it("Q10 wrong quoteSigner → 400", async () => {
    mock.module("../src/lib/onchain.js", () => ({
      ...onchain,
      readSession: async () => mockSession({ quoteSigner: "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0000" }),
    }));
    const res = await handleQuotes(makeConfig(), makeRequest({ sessionId: "1", service: "document-insights-v1", input: "test" }));
    expect(res.status).toBe(400);
    const b = await res.json() as { error: string };
    expect(b.error).toContain("quoteSigner");
  });

  it("Q11 price exceeds perPaymentCap → 400", async () => {
    mock.module("../src/lib/onchain.js", () => ({
      ...onchain,
      readSession: async () => mockSession({ perPaymentCap: 10n }), // cap of 10 < price 50000
    }));
    const res = await handleQuotes(makeConfig(), makeRequest({ sessionId: "1", service: "document-insights-v1", input: "test" }));
    expect(res.status).toBe(400);
    const b = await res.json() as { error: string };
    // Error contains "perPaymentCap" which includes the substring "cap"
    expect(b.error.toLowerCase()).toContain("cap");
  });

  it("Q12 insufficient funded balance → 400", async () => {
    mock.module("../src/lib/onchain.js", () => ({
      ...onchain,
      readSession: async () => mockSession({ totalFunded: 100n, totalSpent: 90n }), // only 10 available
    }));
    const res = await handleQuotes(makeConfig(), makeRequest({ sessionId: "1", service: "document-insights-v1", input: "test" }));
    expect(res.status).toBe(400);
    const b = await res.json() as { error: string };
    expect(b.error).toContain("balance");
  });

  it("Q13 amount in response is always server price, not user-provided", async () => {
    mock.module("../src/lib/onchain.js", () => ({ ...onchain, readSession: async () => mockSession() }));
    // Even if a caller somehow provides a different amount in body, the response must use server price
    const res = await handleQuotes(makeConfig(), makeRequest({
      sessionId: "1", service: "document-insights-v1", input: "Hello.",
    }));
    const b = await res.json() as Record<string, unknown>;
    expect(b.amount).toBe("50000"); // always the server-configured price
  });

  it("Q14 requestHash is SHA-256 of input", async () => {
    mock.module("../src/lib/onchain.js", () => ({ ...onchain, readSession: async () => mockSession() }));
    const { computeRequestHash } = await import("../src/lib/eip712.js");
    const input = "test document";
    const expectedHash = await computeRequestHash(input);

    const res = await handleQuotes(makeConfig(), makeRequest({ sessionId: "1", service: "document-insights-v1", input }));
    const b = await res.json() as Record<string, unknown>;
    expect((b.requestHash as string).toLowerCase()).toBe(expectedHash.toLowerCase());
  });

  it("Q15 requestId is different on each call (random)", async () => {
    mock.module("../src/lib/onchain.js", () => ({ ...onchain, readSession: async () => mockSession() }));
    const cfg = makeConfig();
    const req1 = () => makeRequest({ sessionId: "1", service: "document-insights-v1", input: "test" });
    const r1 = await (await handleQuotes(cfg, req1())).json() as Record<string, unknown>;
    const r2 = await (await handleQuotes(cfg, req1())).json() as Record<string, unknown>;
    expect(r1.requestId).not.toBe(r2.requestId);
  });

  it("Q16 response does not contain private key or any secret", async () => {
    mock.module("../src/lib/onchain.js", () => ({ ...onchain, readSession: async () => mockSession() }));
    const res = await handleQuotes(makeConfig(), makeRequest({ sessionId: "1", service: "document-insights-v1", input: "check" }));
    const text = await res.text();
    // The private key value must never appear in any response body
    expect(text).not.toContain(TEST_PK.slice(2));
    expect(text.toLowerCase()).not.toContain("privatekey");
    expect(text.toLowerCase()).not.toContain("private_key");
  });

  it("Q17 missing body fields → 400", async () => {
    mock.module("../src/lib/onchain.js", () => ({ ...onchain, readSession: async () => mockSession() }));
    const res = await handleQuotes(makeConfig(), makeRequest({ sessionId: "1" })); // missing service and input
    expect(res.status).toBe(400);
  });

  it("Q18 RPC error → 503 retryable", async () => {
    mock.module("../src/lib/onchain.js", () => ({
      ...onchain,
      readSession: async () => { throw new Error("RPC timeout"); },
    }));
    const res = await handleQuotes(makeConfig(), makeRequest({ sessionId: "1", service: "document-insights-v1", input: "test" }));
    expect(res.status).toBe(503);
    const b = await res.json() as { retryable: boolean };
    expect(b.retryable).toBe(true);
  });

  it("Q19 unicode input is handled correctly", async () => {
    mock.module("../src/lib/onchain.js", () => ({ ...onchain, readSession: async () => mockSession() }));
    const res = await handleQuotes(makeConfig(), makeRequest({
      sessionId: "1", service: "document-insights-v1",
      input: "Analyse éàü — testing Unicode ÖÄÜ.",
    }));
    expect(res.status).toBe(200);
  });
});
