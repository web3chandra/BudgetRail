# BudgetRail — Agent Flow Example (Node.js / Bun)

This example shows how to build an **agent wallet B** flow using the BudgetRail SDK
in a standalone Node.js or Bun script. The agent requests a quote, verifies it locally,
simulates the transaction, and submits the payment — all without touching the owner's wallet.

> The owner wallet A is separate. The agent only needs its own wallet for gas and payment signing.

## Prerequisites

- Bun or Node.js 18+
- A wallet whose address matches `session.agent` in a funded BudgetRail session
- Enough Arc Testnet USDC in the agent wallet for gas (native on Arc = USDC)

## Install

```bash
bun add viem @budgetrail/sdk
```

## Environment (never commit these)

```bash
# ~/.budgetrail-agent.env  OR  agent/.env (gitignored)
AGENT_PRIVATE_KEY=0x...               # Agent wallet B private key
PROVIDER_API_URL=http://localhost:3001
BUDGET_RAIL_CONTRACT=0xf6a13df15ad93c2e2968e1d69c53894a923bda21
CHAIN_ID=5042002
RPC_URL=https://rpc.testnet.arc.io
PROVIDER_PAYOUT=0x<payout address C>
QUOTE_SIGNER=0x<signer address D>
```

## Complete agent payment flow

```ts
#!/usr/bin/env bun
import { privateKeyToAccount }                from "viem/accounts";
import { createWalletClient, createPublicClient, http } from "viem";
import {
  readSession, checkProviderHealth, requestQuote,
  verifyQuote, simulatePay, submitPayment,
  retrieveResultByConfirmedPayment, BudgetRailError,
} from "@budgetrail/sdk";

// ── Config ────────────────────────────────────────────────────────────────

const config = {
  contractAddress: process.env.BUDGET_RAIL_CONTRACT as `0x${string}`,
  chainId:         Number(process.env.CHAIN_ID),
  rpcUrl:          process.env.RPC_URL!,
  providerApiUrl:  process.env.PROVIDER_API_URL!,
  providerPayout:  process.env.PROVIDER_PAYOUT  as `0x${string}`,
  quoteSigner:     process.env.QUOTE_SIGNER     as `0x${string}`,
};

const SESSION_ID = 9n;  // Replace with your session ID
const INPUT      = "Analyze this document for insights.";

// ── Build viem signer ─────────────────────────────────────────────────────

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);
const publicClient = createPublicClient({ transport: http(config.rpcUrl) });
const walletClient = createWalletClient({ account, transport: http(config.rpcUrl) });

// SDK signer adapter: wraps viem walletClient
const signer = {
  address: account.address,
  async writeContract(params) {
    return walletClient.writeContract(params as never);
  },
  async waitForReceipt(txHash) {
    return publicClient.waitForTransactionReceipt({ hash: txHash });
  },
};

// ── Run the payment flow ──────────────────────────────────────────────────

async function main() {
  // 1. Verify session
  const session = await readSession(config, SESSION_ID);
  if (!session) throw new Error(`Session ${SESSION_ID} not found`);
  console.log(`Session ${SESSION_ID}: available=${(Number(session.availableBalance)/1e6).toFixed(6)} USDC`);

  if (session.agent.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`This wallet (${account.address}) is not the authorized agent (${session.agent})`);
  }

  // 2. Provider health
  await checkProviderHealth(config);
  console.log("Provider is healthy");

  // 3. Request quote
  const quote = await requestQuote(config, {
    sessionId: SESSION_ID,
    service:   "document-insights-v1",
    input:     INPUT,
  });
  console.log(`Quote: ${quote.displayPrice}, deadline ${new Date(Number(quote.quoteDeadline) * 1000).toISOString()}`);

  // 4. Verify quote locally (signature + all fields)
  await verifyQuote(config, quote, INPUT, SESSION_ID, session.perPaymentCap);
  console.log("Quote verified ✓");

  // 5. Simulate before opening wallet
  await simulatePay(config, account.address, SESSION_ID, quote);
  console.log("Simulation passed ✓");

  // 6. Pay (wallet signs)
  console.log("Submitting payment...");
  const payment = await submitPayment(config, signer, SESSION_ID, quote);
  console.log(`Paid ✓  txHash=${payment.txHash}`);
  console.log(`  settled: ${(Number(payment.settledEvent.amount)/1e6).toFixed(6)} USDC`);

  // 7. Retrieve result (idempotent — uses confirmed txHash, never pays again)
  const { result } = await retrieveResultByConfirmedPayment(config, {
    txHash:    payment.txHash,
    quote,
    inputText: INPUT,
  });
  console.log("Result received:", JSON.stringify(result, null, 2));
}

main().catch((err) => {
  if (err instanceof BudgetRailError) {
    console.error(`BudgetRailError [${err.code}]: ${err.message}`);
    if (err.retryable) console.error("  (retryable — try again later)");
  } else {
    console.error(err);
  }
  process.exit(1);
});
```

## Recovery after interruption

If the process dies after broadcasting but before retrieving the result:

```ts
import { waitForPayment, retrieveResultByConfirmedPayment } from "@budgetrail/sdk";

// Recover from a known txHash (stored in your recovery file)
const payment = await waitForPayment(config, "0x<txHash>", "0x<requestId>");
const { result } = await retrieveResultByConfirmedPayment(config, {
  txHash:    payment.txHash,
  quote,      // restore from recovery file
  inputText: INPUT,
});
```

See `agent/src/lib/recovery.ts` for the full recovery file format.

## Important: agent wallet must have gas

On Arc, native gas IS USDC (same pool, 18-decimal view vs 6-decimal ERC-20 view).
Fund the agent wallet via:
```
Arc Studio sidebar → "Get test USDC" → connect agent wallet
```
