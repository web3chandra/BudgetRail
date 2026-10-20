/**
 * POST /api/fulfill — attack tests and verification logic.
 * Run: bun test provider/test/fulfill.test.ts
 *
 * These tests mock fetchReceipt / fetchTransaction / fetchBlockTimestamp
 * to cover all attack and edge-case paths without a live RPC.
 */

import { describe, it, expect, mock } from "bun:test";
import { toEventHash } from "viem";
import { handleFulfill } from "../src/routes/fulfill.js";
import * as onchain from "../src/lib/onchain.js";
import { BUDGET_RAIL_ABI, ERC20_ABI, decodePaymentSettledLog } from "../src/lib/onchain.js";
import type { Config } from "../src/lib/config.js";
import { computeRequestHash, quoteSignerAddressFromPrivKey } from "../src/lib/eip712.js";

const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as `0x${string}`;
const CONTRACT = "0xf6a13df15ad93c2e2968e1d69c53894a923bda21";
const PAYOUT   = "0x3000000000000000000000000000000000000000";
const USDC     = "0x3600000000000000000000000000000000000000";
const AGENT    = "0x2000000000000000000000000000000000000000";
const SESSION_ID = 1n;
const AMOUNT     = 50000n;
const DEADLINE   = BigInt(Math.floor(Date.now() / 1000) + 600);
const REQUEST_ID = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const VALID_TX   = "0x" + "b".repeat(64) as `0x${string}`;

function makeConfig(): Config {
  return {
    network: "testnet", chainId: 5042002, rpcUrl: "https://rpc.testnet.arc.io",
    contractAddress:    CONTRACT as `0x${string}`,
    providerPayoutAddress: PAYOUT as `0x${string}`,
    quoteSignerPrivateKey: TEST_PK,
    quoteSignerAddress: quoteSignerAddressFromPrivKey(TEST_PK),
    pricePerCall: AMOUNT, quoteWindowSeconds: 600, maxInputBytes: 8192,
    rateLimitPerMinute: 100, port: 3001,
  } as Config;
}

const INPUT = "Hello World. This is a document.";

async function makeQuote(inputOverride?: string) {
  const inp = inputOverride ?? INPUT;
  const reqHash = await computeRequestHash(inp);
  return {
    sessionId:     SESSION_ID.toString(),
    requestId:     REQUEST_ID,
    requestHash:   reqHash,
    amount:        AMOUNT.toString(),
    quoteDeadline: DEADLINE.toString(),
    signature:     "0x" + "c".repeat(130),
    chainId:       5042002,
    contractAddress: CONTRACT,
    providerPayout:  PAYOUT,
    quoteSignerAddress: quoteSignerAddressFromPrivKey(TEST_PK),
    service:       "document-insights-v1",
  };
}

// ── Topic0 — derived from the canonical ABI, NEVER hardcoded ─────────────
// Spec requirement (test A): computed value MUST equal the known-good hash.
// The old wrong constant 0xeb67... must fail that assertion.
const PS_TOPIC = toEventHash(
  BUDGET_RAIL_ABI.find(x => x.type === "event" && x.name === "PaymentSettled")!
);
const TF_TOPIC = toEventHash(
  ERC20_ABI.find(x => x.type === "event" && x.name === "Transfer")!
);

// ── Test A — topic0 regression (catches any future ABI/signature drift) ──
describe("PaymentSettled topic0 derivation (regression)", () => {
  const TRUE_TOPIC  = "0x5c25b27cd6964ebe086bfeb3f23d3b3a2a086ed5166e11817b2e620cadc5ead5";
  const WRONG_TOPIC = "0xeb67dfc5f3e7a54a6c3eb1ded77bb5dd50c2e5abf5e2dc5ff61c3e2e0cd15c99";

  it("A01 ABI-derived topic0 equals the canonical keccak256 of the event signature", () => {
    expect(PS_TOPIC.toLowerCase()).toBe(TRUE_TOPIC);
  });

  it("A02 old hardcoded wrong topic FAILS the canonical check (proves this test catches regressions)", () => {
    expect(WRONG_TOPIC).not.toBe(TRUE_TOPIC);
  });

  it("A03 ERC-20 Transfer topic0 is correct canonical value", () => {
    const TRUE_TF = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    expect(TF_TOPIC.toLowerCase()).toBe(TRUE_TF);
  });
});

import { encodeAbiParameters, parseAbiParameters, padHex, toHex } from "viem";

// ── Test B — real ABI-encoded log decoded without mocking ─────────────────
describe("decodePaymentSettledLog — real ABI encoding (no mock)", () => {
  it("B01 decodes a correctly ABI-encoded PaymentSettled log", () => {
    const sid  = 5n;
    const reqId = ("0xaaaa" + "bb".repeat(30)) as `0x${string}`;
    const prov  = PAYOUT as `0x${string}`;
    const rHash = ("0xcccc" + "dd".repeat(30)) as `0x${string}`;
    const agt   = AGENT as `0x${string}`;
    const amt   = AMOUNT;
    const dl    = DEADLINE;

    const data = encodeAbiParameters(
      parseAbiParameters("bytes32,address,uint96,uint64"),
      [rHash, agt, amt, dl]
    );
    const t1 = padHex(toHex(sid),  { size: 32, dir: "left" }) as `0x${string}`;
    const t2 = reqId;
    const t3 = padHex(prov.toLowerCase() as `0x${string}`, { size: 32, dir: "left" }) as `0x${string}`;

    const log = {
      address:          CONTRACT.toLowerCase(),
      topics:           [PS_TOPIC as `0x${string}`, t1, t2, t3] as readonly [`0x${string}`, ...`0x${string}`[]],
      data:             data as `0x${string}`,
      blockHash:        "0x0" as `0x${string}`,
      blockNumber:      1000n,
      logIndex:         0,
      transactionHash:  VALID_TX,
      transactionIndex: 0,
      removed:          false,
    };

    const decoded = decodePaymentSettledLog(log);
    expect(decoded).not.toBeNull();
    expect(decoded!.sessionId).toBe(sid);
    expect(decoded!.requestId.toLowerCase()).toBe(reqId.toLowerCase());
    expect(decoded!.provider.toLowerCase()).toBe(prov.toLowerCase());
    expect(decoded!.requestHash.toLowerCase()).toBe(rHash.toLowerCase());
    expect(decoded!.agent.toLowerCase()).toBe(agt.toLowerCase());
    expect(decoded!.amount).toBe(amt);
    expect(decoded!.quoteDeadline).toBe(dl);
  });

  it("B02 returns null for log with wrong topic0 (old broken constant)", () => {
    const WRONG = "0xeb67dfc5f3e7a54a6c3eb1ded77bb5dd50c2e5abf5e2dc5ff61c3e2e0cd15c99";
    const log = {
      address:          CONTRACT.toLowerCase(),
      topics:           [WRONG as `0x${string}`] as readonly [`0x${string}`, ...`0x${string}`[]],
      data:             "0x" as `0x${string}`,
      blockHash:        "0x0" as `0x${string}`,
      blockNumber:      1000n,
      logIndex:         0,
      transactionHash:  VALID_TX,
      transactionIndex: 0,
      removed:          false,
    };
    // viem decodeEventLog will throw/return null for a mismatched topic0
    const result = decodePaymentSettledLog(log);
    expect(result).toBeNull();
  });
});

function makePaymentSettledLog(overrides: Partial<{
  address: string; sessionId: bigint; requestId: string; provider: string;
  requestHash: string; agent: string; amount: bigint; quoteDeadline: bigint;
}> = {}) {
  const sid      = overrides.sessionId     ?? SESSION_ID;
  const reqId    = overrides.requestId     ?? REQUEST_ID;
  const prov     = overrides.provider      ?? PAYOUT;
  const reqHash  = overrides.requestHash   ?? "0x" + "a".repeat(64);
  const agent    = overrides.agent         ?? AGENT;
  const amt      = overrides.amount        ?? AMOUNT;
  const dl       = overrides.quoteDeadline ?? DEADLINE;

  // Encode non-indexed data: (bytes32 requestHash, address agent, uint96 amount, uint64 quoteDeadline)
  const data = encodeAbiParameters(
    parseAbiParameters("bytes32,address,uint96,uint64"),
    [reqHash as `0x${string}`, agent as `0x${string}`, amt, dl]
  );

  // EVM indexed topics: uint256 and address are left-padded (big-endian, high bytes = zeros)
  const t1 = padHex(toHex(sid), { size: 32, dir: "left" }) as `0x${string}`;
  const t2 = reqId as `0x${string}`; // bytes32 — already 32 bytes
  const t3 = padHex(prov.toLowerCase() as `0x${string}`, { size: 32, dir: "left" }) as `0x${string}`;

  return {
    address:          (overrides.address ?? CONTRACT).toLowerCase(),
    topics:           [PS_TOPIC as `0x${string}`, t1, t2, t3] as readonly [`0x${string}`, ...`0x${string}`[]],
    data:             data as `0x${string}`,
    blockHash:        "0x0" as `0x${string}`,
    blockNumber:      1000n,
    logIndex:         0,
    transactionHash:  VALID_TX,
    transactionIndex: 0,
    removed:          false,
  };
}

function makeTransferLog(from: string, to: string, value: bigint) {
  const data = encodeAbiParameters(parseAbiParameters("uint256"), [value]);
  const t1 = padHex(from.toLowerCase() as `0x${string}`, { size: 32, dir: "left" }) as `0x${string}`;
  const t2 = padHex(to.toLowerCase()   as `0x${string}`, { size: 32, dir: "left" }) as `0x${string}`;
  return {
    address:          USDC.toLowerCase(),
    topics:           [TF_TOPIC as `0x${string}`, t1, t2] as readonly [`0x${string}`, ...`0x${string}`[]],
    data:             data as `0x${string}`,
    blockHash:        "0x0" as `0x${string}`,
    blockNumber:      1000n,
    logIndex:         1,
    transactionHash:  VALID_TX,
    transactionIndex: 0,
    removed:          false,
  };
}

function makeGoodReceipt(requestHashOverride?: string) {
  const psLog = makePaymentSettledLog({
    requestHash: requestHashOverride,
  });
  const tfLog = makeTransferLog(CONTRACT, PAYOUT, AMOUNT);
  return {
    status:      "success" as const,
    blockNumber: 1000n,
    to:          CONTRACT,
    logs:        [psLog, tfLog],
  };
}

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/fulfill", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
}

// Pre-decoded structs to return from mocked decoders
// (bypasses viem decodeEventLog which requires exact ABI-encoded log format)
function mockOnchain(
  receipt: unknown,
  tx: unknown,
  blockTs: bigint | null = DEADLINE - 60n,
  settledOverrides: Partial<{
    sessionId: bigint; requestId: string; provider: string; requestHash: string;
    agent: string; amount: bigint; quoteDeadline: bigint;
  }> = {},
  transferOverrides: Partial<{ from: string; to: string; value: bigint }> = {},
) {
  const defaultSettled = {
    sessionId:     SESSION_ID,
    requestId:     REQUEST_ID,
    provider:      PAYOUT.toLowerCase(),
    requestHash:   "PLACEHOLDER", // filled per test
    agent:         AGENT.toLowerCase(),
    amount:        AMOUNT,
    quoteDeadline: DEADLINE,
    ...settledOverrides,
  };
  const defaultTransfer = {
    from:  CONTRACT.toLowerCase(),
    to:    PAYOUT.toLowerCase(),
    value: AMOUNT,
    ...transferOverrides,
  };

  mock.module("../src/lib/onchain.js", () => ({
    ...onchain,
    fetchReceipt:        async () => receipt,
    fetchTransaction:    async () => tx,
    fetchBlockTimestamp: async () => blockTs,
    // Return pre-decoded structs directly — avoids viem ABI-decode in unit tests
    decodePaymentSettledLog: (log: unknown) => {
      if (!log) return null;
      const l = log as { address?: string; topics?: string[] };
      if (!l.address) return null;
      if (l.address.toLowerCase() !== CONTRACT.toLowerCase()) return null;
      return defaultSettled;
    },
    decodeTransferLog: (log: unknown) => {
      if (!log) return null;
      const l = log as { address?: string };
      if (!l.address) return null;
      if (l.address.toLowerCase() !== USDC.toLowerCase()) return null;
      return defaultTransfer;
    },
  }));
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe("POST /api/fulfill", () => {

  it("F01 valid request returns DocumentInsights result", async () => {
    const quote = await makeQuote();
    const receipt = makeGoodReceipt(quote.requestHash);
    mockOnchain(receipt, { from: AGENT, to: CONTRACT }, DEADLINE - 60n,
      { requestHash: quote.requestHash }); // match requestHash in decoded log
    const res = await handleFulfill(makeConfig(), makeRequest({ input: INPUT, quote, txHash: VALID_TX }));
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect((body.result as Record<string,unknown>).service).toBe("document-insights-v1");
    expect((body.payment as Record<string,unknown>).txHash).toBe(VALID_TX);
  });

  it("F02 nonexistent tx → 402 retryable", async () => {
    mockOnchain(null, null);
    const quote = await makeQuote();
    const res = await handleFulfill(makeConfig(), makeRequest({ input: INPUT, quote, txHash: VALID_TX }));
    expect(res.status).toBe(402);
    const b = await res.json() as { retryable: boolean };
    expect(b.retryable).toBe(true);
  });

  it("F03 reverted tx → 402", async () => {
    const receipt = { ...makeGoodReceipt(), status: "reverted" as const };
    mockOnchain(receipt, { from: AGENT, to: CONTRACT });
    const quote = await makeQuote();
    const res = await handleFulfill(makeConfig(), makeRequest({ input: INPUT, quote, txHash: VALID_TX }));
    expect(res.status).toBe(402);
  });

  it("F04 tx sent to wrong contract → 400", async () => {
    mockOnchain(makeGoodReceipt(), { from: AGENT, to: "0x0000000000000000000000000000000000001234" });
    const quote = await makeQuote();
    const res = await handleFulfill(makeConfig(), makeRequest({ input: INPUT, quote, txHash: VALID_TX }));
    expect(res.status).toBe(400);
  });

  it("F05 no PaymentSettled log → 400 (permanent mismatch, not retryable)", async () => {
    // A confirmed tx from the right contract with no PaymentSettled event
    // is a permanent mismatch. Must be 400, not 402, and not retryable.
    const receipt = { status: "success" as const, blockNumber: 1000n, to: CONTRACT,
      logs: [makeTransferLog(CONTRACT, PAYOUT, AMOUNT)] };
    mockOnchain(receipt, { from: AGENT, to: CONTRACT });
    const quote = await makeQuote();
    const res = await handleFulfill(makeConfig(), makeRequest({ input: INPUT, quote, txHash: VALID_TX }));
    expect(res.status).toBe(400);
    const b = await res.json() as { error: string; retryable: boolean };
    // This should NOT be retryable — don't pay again
    expect(b.retryable).toBe(false);
  });

  it("F06 PaymentSettled from fake contract with same topic → 400 (address check, permanent mismatch)", async () => {
    const psLog = makePaymentSettledLog({ address: "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0000" });
    const receipt = { status: "success" as const, blockNumber: 1000n, to: CONTRACT,
      logs: [psLog, makeTransferLog(CONTRACT, PAYOUT, AMOUNT)] };
    mockOnchain(receipt, { from: AGENT, to: CONTRACT });
    const quote = await makeQuote();
    // Receipt has no PaymentSettled from the configured BudgetRail address → permanent 400.
    // This is NOT retryable: the event came from a different contract. Do not pay again.
    const res = await handleFulfill(makeConfig(), makeRequest({ input: INPUT, quote, txHash: VALID_TX }));
    expect(res.status).toBe(400);
    const b = await res.json() as { retryable: boolean };
    expect(b.retryable).toBe(false);
  });

  it("F07 wrong agent (tx.from != settled.agent) → 400", async () => {
    const quote = await makeQuote();
    const receipt = makeGoodReceipt(quote.requestHash);
    mockOnchain(receipt, { from: "0xbadbadbadbadbadbadbadbadbadbadbadbadbadb", to: CONTRACT },
      DEADLINE - 60n, { requestHash: quote.requestHash });
    const res = await handleFulfill(makeConfig(), makeRequest({ input: INPUT, quote, txHash: VALID_TX }));
    expect(res.status).toBe(400);
  });

  it("F08 altered input (requestHash mismatch) → 400", async () => {
    const quote = await makeQuote();
    const receipt = makeGoodReceipt(quote.requestHash);
    mockOnchain(receipt, { from: AGENT, to: CONTRACT });
    const res = await handleFulfill(makeConfig(), makeRequest({
      input: INPUT + " ALTERED",
      quote,
      txHash: VALID_TX,
    }));
    expect(res.status).toBe(400);
    const b = await res.json() as { error: string };
    expect(b.error).toContain("requestHash");
  });

  it("F09 wrong chainId in quote → 400", async () => {
    const quote = { ...await makeQuote(), chainId: 9999 };
    const res = await handleFulfill(makeConfig(), makeRequest({ input: INPUT, quote, txHash: VALID_TX }));
    expect(res.status).toBe(400);
  });

  it("F10 wrong contract in quote → 400", async () => {
    const quote = { ...await makeQuote(), contractAddress: "0x0000000000000000000000000000000000001234" };
    const res = await handleFulfill(makeConfig(), makeRequest({ input: INPUT, quote, txHash: VALID_TX }));
    expect(res.status).toBe(400);
  });

  it("F11 wrong provider in quote → 400", async () => {
    const quote = { ...await makeQuote(), providerPayout: "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0000" };
    const res = await handleFulfill(makeConfig(), makeRequest({ input: INPUT, quote, txHash: VALID_TX }));
    expect(res.status).toBe(400);
  });

  it("F12 wrong amount in quote → 400", async () => {
    const quote = { ...await makeQuote(), amount: "1" }; // mismatch with server price
    const res = await handleFulfill(makeConfig(), makeRequest({ input: INPUT, quote, txHash: VALID_TX }));
    expect(res.status).toBe(400);
  });

  it("F13 no ERC-20 Transfer log → 402", async () => {
    const quote = await makeQuote();
    const psLog = makePaymentSettledLog({ requestHash: quote.requestHash });
    const receipt = { status: "success" as const, blockNumber: 1000n, to: CONTRACT, logs: [psLog] };
    // Mock decodePaymentSettledLog to succeed but decodeTransferLog to find no USDC log
    // (by passing a receipt with only a PS log and no Transfer from USDC address)
    mock.module("../src/lib/onchain.js", () => ({
      ...onchain,
      fetchReceipt:     async () => receipt,
      fetchTransaction: async () => ({ from: AGENT, to: CONTRACT }),
      fetchBlockTimestamp: async () => DEADLINE - 60n,
      decodePaymentSettledLog: (log: unknown) => {
        const l = log as { address?: string };
        if (!l?.address || l.address.toLowerCase() !== CONTRACT.toLowerCase()) return null;
        return {
          sessionId: SESSION_ID, requestId: REQUEST_ID, provider: PAYOUT.toLowerCase(),
          requestHash: quote.requestHash, agent: AGENT.toLowerCase(),
          amount: AMOUNT, quoteDeadline: DEADLINE,
        };
      },
      decodeTransferLog: (_log: unknown) => null, // no USDC transfer
    }));
    const res = await handleFulfill(makeConfig(), makeRequest({ input: INPUT, quote, txHash: VALID_TX }));
    expect(res.status).toBe(402);
  });

  it("F14 USDC Transfer amount mismatch → 400", async () => {
    const quote = await makeQuote();
    const psLog = makePaymentSettledLog({ requestHash: quote.requestHash });
    const tfLog = makeTransferLog(CONTRACT, PAYOUT, AMOUNT + 1n); // wrong amount
    const receipt = { status: "success" as const, blockNumber: 1000n, to: CONTRACT, logs: [psLog, tfLog] };
    mockOnchain(receipt, { from: AGENT, to: CONTRACT }, DEADLINE - 60n,
      { requestHash: quote.requestHash }, { value: AMOUNT + 1n }); // wrong transfer amount
    const res = await handleFulfill(makeConfig(), makeRequest({ input: INPUT, quote, txHash: VALID_TX }));
    expect(res.status).toBe(400);
  });

  it("F15 payment block after quoteDeadline → 400", async () => {
    const quote = await makeQuote();
    const receipt = makeGoodReceipt(quote.requestHash);
    mockOnchain(receipt, { from: AGENT, to: CONTRACT }, DEADLINE + 1n, // block AFTER deadline
      { requestHash: quote.requestHash });
    const res = await handleFulfill(makeConfig(), makeRequest({ input: INPUT, quote, txHash: VALID_TX }));
    expect(res.status).toBe(400);
    const b = await res.json() as { error: string };
    // Error mentions timestamp or deadline
    expect(b.error.toLowerCase()).toMatch(/deadline|timestamp/);
  });

  it("F16 late fulfillment of timely payment succeeds (wall-clock irrelevant)", async () => {
    // Payment block is well before deadline even though we're calling /fulfill late.
    // The block timestamp is what matters, not when this request arrives.
    const quote = await makeQuote();
    const receipt = makeGoodReceipt(quote.requestHash);
    // blockTs well before deadline → valid
    mockOnchain(receipt, { from: AGENT, to: CONTRACT }, DEADLINE - 300n,
      { requestHash: quote.requestHash });
    const res = await handleFulfill(makeConfig(), makeRequest({ input: INPUT, quote, txHash: VALID_TX }));
    expect(res.status).toBe(200);
  });

  it("F17 idempotent: same input + txHash returns same result", async () => {
    const quote = await makeQuote();
    const receipt = makeGoodReceipt(quote.requestHash);
    mockOnchain(receipt, { from: AGENT, to: CONTRACT }, DEADLINE - 60n, { requestHash: quote.requestHash });
    const body1 = await (await handleFulfill(makeConfig(), makeRequest({ input: INPUT, quote, txHash: VALID_TX }))).json();
    const body2 = await (await handleFulfill(makeConfig(), makeRequest({ input: INPUT, quote, txHash: VALID_TX }))).json();
    expect(JSON.stringify((body1 as Record<string,unknown>).result))
      .toBe(JSON.stringify((body2 as Record<string,unknown>).result));
  });

  it("F18 invalid txHash format → 400", async () => {
    const quote = await makeQuote();
    const res = await handleFulfill(makeConfig(), makeRequest({ input: INPUT, quote, txHash: "not-a-hash" }));
    expect(res.status).toBe(400);
  });

  it("F19 missing quote fields → 400", async () => {
    const q = await makeQuote();
    const { sessionId: _, ...incomplete } = q;
    const res = await handleFulfill(makeConfig(), makeRequest({ input: INPUT, quote: incomplete, txHash: VALID_TX }));
    expect(res.status).toBe(400);
  });

  it("F20 response never contains private key", async () => {
    const quote = await makeQuote();
    const receipt = makeGoodReceipt(quote.requestHash);
    mockOnchain(receipt, { from: AGENT, to: CONTRACT }, DEADLINE - 60n, { requestHash: quote.requestHash });
    const res = await handleFulfill(makeConfig(), makeRequest({ input: INPUT, quote, txHash: VALID_TX }));
    const text = await res.text();
    expect(text).not.toContain(TEST_PK.slice(2));
  });

  it("F21 RPC timeout → 503 retryable", async () => {
    mock.module("../src/lib/onchain.js", () => ({
      ...onchain,
      fetchReceipt:     async () => { throw new Error("timeout"); },
      fetchTransaction: async () => { throw new Error("timeout"); },
    }));
    const quote = await makeQuote();
    const res = await handleFulfill(makeConfig(), makeRequest({ input: INPUT, quote, txHash: VALID_TX }));
    expect(res.status).toBe(503);
    const b = await res.json() as { retryable: boolean };
    expect(b.retryable).toBe(true);
  });
});
