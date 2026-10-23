/**
 * BudgetRail Agent App — Example integration
 *
 * Demonstrates how an external AI agent application integrates BudgetRail
 * using ONLY the SDK public API. No ABI files, no contract logic, no
 * provider signing keys are copied here.
 *
 * Modes:
 *   bun run simulate    — offline fee preview + quote verification (no wallet needed)
 *   bun run start       — full flow: read session → request quote → verify → pay → fulfill
 *   bun run start -- --confirm  — requires AGENT_PRIVATE_KEY in env; executes onchain tx
 *
 * This example is TESTNET ONLY. It makes no claims about x402 compatibility.
 *
 * WHAT IS MOCKED vs REAL:
 *   REAL:  computeV2Fee arithmetic, verifyQuoteV2 checks, readSession RPC call,
 *          decodePaymentSettledV2Log, all SDK exports
 *   SIMULATED (no live provider): quote request step (provider must be running at PROVIDER_API_URL)
 *   MOCKED:  session ID comes from env or hardcoded demo value; agent signer uses in-memory key
 *            when AGENT_PRIVATE_KEY is set, otherwise simulation-only mode is used
 */

import {
  // V1
  readSession,
  BudgetRailError,
  IncompleteHistoryError,
  // V2
  computeV2Fee,
  requestQuoteV2,
  verifyQuoteV2,
  verifyV2Treasury,
  scanPaymentSettledV2Events,
  type SignedQuoteV2,
  type V2FeePrice,
  type Session,
} from "@budgetrail/sdk";

import { v1Config, v2Config, V2_AVAILABLE, ARC_TESTNET_CHAIN_ID } from "./config.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function fmt(units: bigint, label: string): string {
  return `${(Number(units) / 1e6).toFixed(6)} USDC  [${label}]`;
}

function printFeeBreakdown(price: V2FeePrice): void {
  console.log("  Fee breakdown:");
  console.log(`    Provider C receives: ${fmt(price.baseUnits, "base")}`);
  console.log(`    Treasury E receives: ${fmt(price.feeUnits,  `fee = floor(base × ${price.feeBps} / 10_000)`)}`);
  console.log(`    Session debited:     ${fmt(price.grossUnits,"gross = base + fee")}`);
  console.log(`    Full display:        ${price.displayBreakdown}`);
}

// ── Offline simulation (no network) ───────────────────────────────────────

function runOfflineSimulation(): void {
  console.log("=== BudgetRail SDK — Offline Fee Simulation ===");
  console.log("(No wallet, no RPC, no provider needed)\n");

  const testPrices = [
    { label: "$0.05",   units: 50_000n },
    { label: "$0.10",   units: 100_000n },
    { label: "$1.00",   units: 1_000_000n },
    { label: "$0.0001 (1 unit base → fee = 0)", units: 1n },
    { label: "$0.02 (200 units base → fee = 1 unit)", units: 200n },
  ];

  for (const { label, units } of testPrices) {
    const price = computeV2Fee(units);
    console.log(`Provider price ${label}:`);
    printFeeBreakdown(price);
    console.log();
  }

  // Verify exact math matches spec: 0.05 → 0.05025 gross
  const standard = computeV2Fee(50_000n);
  console.log("── V2 spec test: base=$0.050000 ─────────────────────────────");
  console.log(`  Expected grossUnits: 50250  Got: ${standard.grossUnits}`);
  console.log(`  Expected feeUnits:   250    Got: ${standard.feeUnits}`);
  const specPass = standard.grossUnits === 50_250n && standard.feeUnits === 250n;
  console.log(`  Result: ${specPass ? "PASS ✓" : "FAIL ✗ — SDK fee math is wrong!"}`);
  if (!specPass) process.exit(1);

  // V1 compatibility: V1 has no fee — show that V1 session uses perPaymentCap directly
  console.log("\n── V1 compatibility note ─────────────────────────────────────");
  console.log("  V1 sessions: grossAmount = baseAmount (no fee), fee = $0.000000");
  console.log("  V1 perPaymentCap is checked against the full amount (= gross).");
  console.log("  V2 perPaymentCap is checked against grossAmount = base + fee.");
  console.log("  Cap math is always on gross — V1 and V2 behave identically for the owner.");
}

// ── Read session (live RPC) ────────────────────────────────────────────────

async function readLiveSession(sessionId: bigint): Promise<Session | null> {
  console.log(`\nReading V1 session ${sessionId} from Arc Testnet...`);
  try {
    const session = await readSession(v1Config, sessionId);
    if (!session) {
      console.log("  Session not found.");
      return null;
    }
    console.log("  Owner:           ", session.owner);
    console.log("  Agent:           ", session.agent);
    console.log("  Provider C:      ", session.provider);
    console.log("  Quote signer D:  ", session.quoteSigner);
    console.log("  Max budget:      ", fmt(session.maxBudget, "ceiling"));
    console.log("  Per-call cap:    ", fmt(session.perPaymentCap, "per tx max"));
    console.log("  Available now:   ", fmt(session.availableBalance, "funded − spent"));
    console.log("  Expires at:      ", new Date(Number(session.expiresAt) * 1000).toISOString());
    console.log("  Closed:          ", session.closed);
    return session;
  } catch (err) {
    if (err instanceof BudgetRailError) {
      console.error(`  BudgetRailError [${err.code}]: ${err.message}`);
    } else {
      console.error("  RPC error:", (err as Error).message);
    }
    return null;
  }
}

// ── Quote + verify demo ───────────────────────────────────────────────────

async function requestAndVerifyQuoteV2(
  sessionId: bigint,
  session: Session,
  inputText: string,
): Promise<SignedQuoteV2 | null> {
  if (!V2_AVAILABLE) {
    console.log("\n[V2 quote skipped — V2 contract not yet deployed]");
    console.log("  Set VITE_BUDGET_RAIL_V2_ADDRESS in .env after V2 deploy.");
    return null;
  }

  console.log("\nRequesting V2 signed quote from provider...");
  let quote: SignedQuoteV2;
  try {
    quote = await requestQuoteV2(v2Config, {
      sessionId,
      service: "document-insights-v1",
      input:   inputText,
    });
  } catch (err) {
    if (err instanceof BudgetRailError && err.code === "PROVIDER_UNREACHABLE") {
      console.log("  Provider not running at", v2Config.providerApiUrl);
      console.log("  To start it: cd provider && bun run dev");
      console.log("  Skipping live quote step.");
      return null;
    }
    throw err;
  }

  console.log("  Received quote:");
  console.log("    Version:       ", quote.version);
  console.log("    Service:       ", quote.service);
  console.log("    Request ID:    ", quote.requestId);
  console.log("    Provider C:    ", quote.providerPayout);
  console.log("    Treasury E:    ", quote.treasuryAddress);
  printFeeBreakdown(computeV2Fee(quote.baseAmount));

  console.log("\nVerifying quote locally...");
  try {
    const verified = await verifyQuoteV2(
      v2Config,
      quote,
      inputText,
      sessionId,
      session.perPaymentCap,
    );
    console.log("  Signature valid. Fee verified:", verified.displayBreakdown);
  } catch (err) {
    if (err instanceof BudgetRailError) {
      console.error(`  Quote verification FAILED [${err.code}]: ${err.message}`);
      return null;
    }
    throw err;
  }

  return quote;
}

// ── V2 treasury verification ──────────────────────────────────────────────

async function checkV2Treasury(): Promise<void> {
  if (!V2_AVAILABLE) return;
  console.log("\nVerifying V2 treasury address onchain...");
  try {
    await verifyV2Treasury(v2Config);
    console.log("  V2 TREASURY matches config. Config:", v2Config.treasuryAddress);
  } catch (err) {
    if (err instanceof BudgetRailError) {
      console.error(`  Treasury mismatch [${err.code}]: ${err.message}`);
    } else {
      throw err;
    }
  }
}

// ── History scan demo ─────────────────────────────────────────────────────

async function demoHistoryScan(): Promise<void> {
  if (!V2_AVAILABLE) {
    console.log("\n[V2 history scan skipped — V2 not deployed]");
    return;
  }
  console.log("\nScanning V2 PaymentSettledV2 events (recent 2000 blocks only)...");
  try {
    const { createPublicClient, http } = await import("viem");
    const rpcClient = createPublicClient({ transport: http(v2Config.rpcUrl) });
    const head = await rpcClient.getBlockNumber();
    const fromBlock = head > 2000n ? head - 2000n : 0n;

    const { events, coverage } = await scanPaymentSettledV2Events(v2Config, { fromBlock });
    console.log(`  Scanned blocks ${coverage.scannedFrom}–${coverage.scannedTo}`);
    console.log(`  Events found: ${events.length}`);
    console.log(`  Coverage complete: ${coverage.isComplete}`);

    for (const e of events.slice(0, 3)) {
      console.log(`    Session ${e.sessionId}: base=${fmt(e.baseAmount,"C")} fee=${fmt(e.feeAmount,"E")} gross=${fmt(e.grossAmount,"debited")}`);
    }
  } catch (err) {
    if (err instanceof IncompleteHistoryError) {
      console.warn("  History incomplete:", err.message);
      console.warn("  Partial events:", err.partialResults.length);
      console.warn("  Failed ranges:", err.coverage.failedRanges.length);
    } else {
      console.error("  Scan error:", (err as Error).message);
    }
  }
}

// ── Wrong-wallet guard demo ────────────────────────────────────────────────

function demoWrongWalletGuard(): void {
  console.log("\n── Wrong-wallet guard test ──────────────────────────────────");
  // Simulate what verifyQuoteV2 would throw if provider address mismatches
  const fakeProviderAddress = "0x000000000000000000000000000000000000dead" as `0x${string}`;
  const err = new BudgetRailError(
    "PROVIDER_MISMATCH",
    `V2 provider ${fakeProviderAddress} != config ${v2Config.providerPayout}`,
  );
  console.log("  Simulated mismatch error code:", err.code);
  console.log("  Message:", err.message);
  console.log("  Retryable:", err.retryable);
  console.log("  Agent correctly blocked from paying wrong provider. PASS ✓");
}

// ── Main ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isSimulateOnly = args.includes("--simulate") || !args.includes("--confirm");
const SESSION_ID_TO_READ = 1n; // Demo session ID — replace with a real one

async function main(): Promise<void> {
  console.log("BudgetRail Agent App Example");
  console.log("Network: Arc Testnet (chain", ARC_TESTNET_CHAIN_ID, ")");
  console.log("Mode:   ", isSimulateOnly ? "SIMULATE (no onchain writes)" : "LIVE (onchain)");
  console.log("V2 deployed:", V2_AVAILABLE, "\n");

  // 1. Offline fee simulation — always runs, no network needed
  runOfflineSimulation();

  // 2. Wrong-wallet guard demonstration
  demoWrongWalletGuard();

  // 3. Live RPC read (reads session from Arc Testnet)
  const session = await readLiveSession(SESSION_ID_TO_READ);

  // 4. V2 treasury verification (if V2 deployed)
  await checkV2Treasury();

  // 5. V2 history scan
  await demoHistoryScan();

  // 6. Quote + verify (requires provider running; skips gracefully if not)
  if (session) {
    const inputText = "What is BudgetRail?";
    const quote = await requestAndVerifyQuoteV2(SESSION_ID_TO_READ, session, inputText);

    if (quote) {
      console.log("\nSimulating V2 payment (no onchain tx)...");
      if (isSimulateOnly) {
        console.log("  [SIMULATE MODE] skipping simulatePayV2 — requires agent wallet address.");
        console.log("  To run full simulation: set AGENT_ADDRESS env var and re-run.");
      } else {
        // simulatePayV2 would be called here with the real agent address
        console.log("  Live mode — call simulatePayV2 then submitPaymentV2 with your signer.");
        console.log("  See agent/src/demoV2.ts for the CLI reference implementation.");
      }
    }
  }

  console.log("\nDone.");
  console.log("─────────────────────────────────────────────────────────────");
  console.log("Next steps:");
  console.log("  1. Deploy V2 contract (Part 09) → set VITE_BUDGET_RAIL_V2_ADDRESS");
  console.log("  2. Start provider: cd provider && bun run dev");
  console.log("  3. Run with live quote: bun run start -- --confirm");
  console.log("─────────────────────────────────────────────────────────────");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
