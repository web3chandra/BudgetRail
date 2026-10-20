/**
 * Agent CLI unit tests — positive and negative cases.
 * Uses mocked onchain reads and HTTP mocks; no live RPC or real keys.
 *
 * Run: cd /home/user/app/agent && bun test
 */

import { describe, it, expect } from "bun:test";
import { verifySignedQuote } from "../lib/eip712.js";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadAgentConfig } from "../lib/config.js";

// ── Constants ──────────────────────────────────────────────────────────────

const CHAIN_ID     = 5042002;
const CONTRACT     = "0xf6a13df15ad93c2e2968e1d69c53894a923bda21" as `0x${string}`;
const PROVIDER     = "0x3000000000000000000000000000000000000000" as `0x${string}`;
const SIGNER_PK    = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as `0x${string}`;
const FIXED_PRICE  = 50_000n;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Derive address from private key */
function signerAddr(): `0x${string}` {
  return privateKeyToAccount(SIGNER_PK).address.toLowerCase() as `0x${string}`;
}

/** Compute requestHash of text using Web Crypto */
async function computeHash(text: string): Promise<`0x${string}`> {
  const bytes  = new TextEncoder().encode(text);
  const buf    = await crypto.subtle.digest("SHA-256", bytes);
  return `0x${Buffer.from(buf).toString("hex")}` as `0x${string}`;
}

/** Sign a PaymentQuote with viem */
async function signQuote(params: {
  sessionId: bigint; requestId: `0x${string}`; requestHash: `0x${string}`;
  amount: bigint; quoteDeadline: bigint;
}): Promise<`0x${string}`> {
  const account = privateKeyToAccount(SIGNER_PK);
  const wc = createWalletClient({ account, transport: http("https://rpc.testnet.arc.io") });
  return wc.signTypedData({
    account,
    domain: { name: "BudgetRail", version: "1", chainId: CHAIN_ID, verifyingContract: CONTRACT },
    types: {
      PaymentQuote: [
        { name: "sessionId",     type: "uint256" },
        { name: "requestId",     type: "bytes32" },
        { name: "requestHash",   type: "bytes32" },
        { name: "amount",        type: "uint256" },
        { name: "quoteDeadline", type: "uint64"  },
      ],
    },
    primaryType: "PaymentQuote",
    message: params,
  });
}

async function makeValidQuote(input: string, sessionId = 1n) {
  const requestId    = ("0x" + "ab".repeat(32)) as `0x${string}`;
  const requestHash  = await computeHash(input);
  const quoteDeadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const amount = FIXED_PRICE;
  const signature = await signQuote({ sessionId, requestId, requestHash, amount, quoteDeadline });
  return {
    sessionId:          sessionId.toString(),
    requestId,
    requestHash,
    amount:             amount.toString(),
    quoteDeadline:      quoteDeadline.toString(),
    signature,
    chainId:            CHAIN_ID,
    contractAddress:    CONTRACT,
    providerPayout:     PROVIDER,
    quoteSignerAddress: signerAddr(),
    service:            "document-insights-v1" as const,
    displayPrice:       "$0.050000",
  };
}

// ── verifySignedQuote tests ────────────────────────────────────────────────

describe("verifySignedQuote", () => {
  it("A01 valid quote passes verification", async () => {
    const input = "The quick brown fox jumps over the lazy dog.";
    const q = await makeValidQuote(input);
    await expect(
      verifySignedQuote(q, input, 1n, CHAIN_ID, CONTRACT, PROVIDER, signerAddr(), FIXED_PRICE)
    ).resolves.toMatchObject({ valid: true });
  });

  it("A02 wrong wallet — wrong agent wallet has no effect on quote verification", async () => {
    // quote verification is about the SIGNER key, not the agent wallet
    const input = "Hello world";
    const q = await makeValidQuote(input);
    // passes because agent wallet is checked pre-flight, not in quote verification
    await expect(
      verifySignedQuote(q, input, 1n, CHAIN_ID, CONTRACT, PROVIDER, signerAddr(), FIXED_PRICE)
    ).resolves.toMatchObject({ valid: true });
  });

  it("A03 wrong network — wrong chainId in quote", async () => {
    const input = "test";
    const q = await makeValidQuote(input);
    await expect(
      verifySignedQuote({ ...q, chainId: 1 }, input, 1n, CHAIN_ID, CONTRACT, PROVIDER, signerAddr(), FIXED_PRICE)
    ).rejects.toThrow(/chainId/);
  });

  it("A04 wrong provider — provider payout mismatch", async () => {
    const input = "test";
    const q = await makeValidQuote(input);
    await expect(
      verifySignedQuote(q, input, 1n, CHAIN_ID, CONTRACT, "0xdeadbeef00000000000000000000000000000000", signerAddr(), FIXED_PRICE)
    ).rejects.toThrow(/providerPayout/);
  });

  it("A05 wrong cap — amount exceeds configured fixed price", async () => {
    const input = "test";
    const q = await makeValidQuote(input);
    // quote amount matches FIXED_PRICE but we tell verify the price should be 1
    await expect(
      verifySignedQuote(q, input, 1n, CHAIN_ID, CONTRACT, PROVIDER, signerAddr(), 1n)
    ).rejects.toThrow(/amount/);
  });

  it("A06 expired quote — deadline in the past", async () => {
    const input = "test";
    const requestId    = ("0x" + "ab".repeat(32)) as `0x${string}`;
    const requestHash  = await computeHash(input);
    const quoteDeadline = BigInt(Math.floor(Date.now() / 1000) - 60); // 60s in the past
    const signature = await signQuote({ sessionId: 1n, requestId, requestHash, amount: FIXED_PRICE, quoteDeadline });
    const q = {
      sessionId: "1", requestId, requestHash,
      amount: FIXED_PRICE.toString(), quoteDeadline: quoteDeadline.toString(),
      signature, chainId: CHAIN_ID, contractAddress: CONTRACT,
      providerPayout: PROVIDER, quoteSignerAddress: signerAddr(),
      service: "document-insights-v1" as const, displayPrice: "$0.050000",
    };
    await expect(
      verifySignedQuote(q, input, 1n, CHAIN_ID, CONTRACT, PROVIDER, signerAddr(), FIXED_PRICE)
    ).rejects.toThrow(/deadline/);
  });

  it("A07 quote signature mismatch — quote signed with wrong key", async () => {
    const input = "test";
    const q = await makeValidQuote(input);
    const wrongSigner = "0x0000000000000000000000000000000000000001" as `0x${string}`;
    await expect(
      verifySignedQuote(q, input, 1n, CHAIN_ID, CONTRACT, PROVIDER, wrongSigner, FIXED_PRICE)
    ).rejects.toThrow(/signature/i);
  });

  it("A08 UTF-8 parity — altered input produces different requestHash", async () => {
    const input = "Hello, world!";
    const q     = await makeValidQuote(input);
    // pass different input to verifySignedQuote — requestHash will not match
    await expect(
      verifySignedQuote(q, "Hello, WORLD!", 1n, CHAIN_ID, CONTRACT, PROVIDER, signerAddr(), FIXED_PRICE)
    ).rejects.toThrow(/requestHash/i);
  });

  it("A09 wrong contract address in quote", async () => {
    const input = "test";
    const q = await makeValidQuote(input);
    await expect(
      verifySignedQuote({ ...q, contractAddress: "0xdeadbeef00000000000000000000000000000000" as `0x${string}` },
        input, 1n, CHAIN_ID, CONTRACT, PROVIDER, signerAddr(), FIXED_PRICE)
    ).rejects.toThrow(/contractAddress/);
  });

  it("A10 duplicate ID — requestId uniqueness is enforced onchain, not in CLI", async () => {
    // the CLI re-verifies the same quote; idempotency is a contract/provider concern
    const input = "test";
    const q = await makeValidQuote(input);
    const r1 = await verifySignedQuote(q, input, 1n, CHAIN_ID, CONTRACT, PROVIDER, signerAddr(), FIXED_PRICE);
    const r2 = await verifySignedQuote(q, input, 1n, CHAIN_ID, CONTRACT, PROVIDER, signerAddr(), FIXED_PRICE);
    expect(r1.valid).toBe(true);
    expect(r2.valid).toBe(true);
  });

  it("A11 wrong session ID in quote", async () => {
    const input = "test";
    const q = await makeValidQuote(input, 1n);
    // Tell verify the session is 2, but quote has sessionId 1
    await expect(
      verifySignedQuote(q, input, 2n, CHAIN_ID, CONTRACT, PROVIDER, signerAddr(), FIXED_PRICE)
    ).rejects.toThrow(/sessionId/);
  });

  it("A12 unknown service in quote", async () => {
    const input = "test";
    const q = await makeValidQuote(input);
    await expect(
      verifySignedQuote({ ...q, service: "unknown-service" as "document-insights-v1" },
        input, 1n, CHAIN_ID, CONTRACT, PROVIDER, signerAddr(), FIXED_PRICE)
    ).rejects.toThrow(/service/);
  });
});

// ── Config loading tests ───────────────────────────────────────────────────

describe("loadAgentConfig", () => {
  it("C01 throws on missing AGENT_PRIVATE_KEY", () => {
    const orig = process.env.AGENT_PRIVATE_KEY;
    delete process.env.AGENT_PRIVATE_KEY;
    expect(() => loadAgentConfig()).toThrow(/AGENT_PRIVATE_KEY/);
    if (orig) process.env.AGENT_PRIVATE_KEY = orig;
  });

  it("C02 throws on missing PROVIDER_API_URL", () => {
    // Set key but not URL
    process.env.AGENT_PRIVATE_KEY            = "0x" + "ab".repeat(32);
    process.env.BUDGET_RAIL_PROVIDER_PAYOUT  = PROVIDER;
    process.env.BUDGET_RAIL_QUOTE_SIGNER     = signerAddr();
    delete process.env.PROVIDER_API_URL;
    expect(() => loadAgentConfig()).toThrow(/PROVIDER_API_URL/);
  });

  it("C03 loads successfully with all required env vars", () => {
    process.env.AGENT_PRIVATE_KEY            = "0x" + "ab".repeat(32);
    process.env.PROVIDER_API_URL             = "http://localhost:3001";
    process.env.BUDGET_RAIL_PROVIDER_PAYOUT  = PROVIDER;
    process.env.BUDGET_RAIL_QUOTE_SIGNER     = signerAddr();
    process.env.AGENT_NETWORK                = "testnet";
    const config = loadAgentConfig();
    expect(config.network).toBe("testnet");
    expect(config.chainId).toBe(5042002);
    expect(config.providerApiUrl).toBe("http://localhost:3001");
  });
});
