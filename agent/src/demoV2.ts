#!/usr/bin/env bun
/**
 * BudgetRail V2 Agent Demo CLI
 *
 * Usage:
 *   pnpm agent:v2 --session 1 --text-file ./samples/document.txt
 *   pnpm agent:v2 --session 1 --text "Hello world"
 *   pnpm agent:v2 --session 1 --text-file ./samples/document.txt --dry-run
 *   pnpm agent:v2 --session 1 --retry-request-id 0x...
 *
 * Required env (same as V1 demo, plus V2 contract and treasury):
 *   AGENT_PRIVATE_KEY              — 0x-prefixed key of wallet B
 *   PROVIDER_API_URL               — e.g. http://localhost:3001
 *   BUDGET_RAIL_PROVIDER_PAYOUT    — provider payout address C
 *   BUDGET_RAIL_QUOTE_SIGNER       — quote signer address D
 *   BUDGET_RAIL_V2_ADDRESS         — V2 contract address
 *   BUDGET_RAIL_V2_TREASURY        — treasury E address (must match V2 contract immutable)
 *
 * V2 differences from V1 demo:
 *   - Uses /api/quotes/v2 and /api/fulfill/v2
 *   - Shows explicit base / fee / gross price breakdown before confirmation
 *   - Verifies treasury E address from chain before any payment
 *   - Uses payForRequestV2(sessionId, baseAmount, feeAmount, requestId, deadline, sig)
 *   - Detects PaymentSettledV2 (not PaymentSettled)
 *
 * Safety guarantees (same as V1):
 *   - Operator confirmation before any onchain spend (unless --no-confirm)
 *   - Recovery metadata saved BEFORE broadcast
 *   - Never retries the onchain transaction; only retries /api/fulfill/v2
 *   - Each invocation is a single, operator-controlled payment — not autonomous
 */

import { readFile as readFileNode, existsSync } from "node:fs";
import { promisify } from "node:util";
import * as readline from "node:readline";
import { loadAgentConfig } from "./lib/config.js";
import {
  makePublicClient, makeWalletClient,
  verifySessionPreFlightV2,
  estimatePayForRequestV2Gas,
  submitPayForRequestV2,
  waitForReceipt,
  findPaymentSettledV2Log,
} from "./lib/chain.js";
import { verifySignedQuoteV2, type SignedQuoteV2 } from "./lib/eip712V2.js";
import { saveRecovery, loadRecovery, deleteRecovery } from "./lib/recovery.js";
import {
  printBanner, printError, printWarning, printSuccess, printInsights,
} from "./lib/display.js";
import { MIN_GAS_NATIVE_UNITS } from "./lib/constants.js";

const readFileProm = promisify(readFileNode);

// ── V2-specific env ────────────────────────────────────────────────────────

function requireV2Env(name: string): string {
  const v = process.env[name];
  if (!v?.trim()) throw new Error(`Missing required V2 env variable: ${name}`);
  return v.trim();
}

// ── CLI arg parsing ────────────────────────────────────────────────────────

interface CliArgs {
  sessionId:       bigint;
  input:           string;
  dryRun:          boolean;
  noConfirm:       boolean;
  retryRequestId?: `0x${string}`;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const get  = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

  const sessionStr = get("--session");
  if (!sessionStr) {
    console.error("Usage: pnpm agent:v2 --session <id> --text-file <path>|--text <text> [--dry-run] [--no-confirm]");
    console.error("       pnpm agent:v2 --session <id> --retry-request-id <0xhex>");
    process.exit(1);
  }
  return {
    sessionId:       BigInt(sessionStr),
    input:           "",
    dryRun:          args.includes("--dry-run"),
    noConfirm:       args.includes("--no-confirm"),
    retryRequestId:  get("--retry-request-id") as `0x${string}` | undefined,
  };
}

async function resolveInput(): Promise<string> {
  const args = process.argv.slice(2);
  const textFile   = (() => { const i = args.indexOf("--text-file");  return i >= 0 ? args[i + 1] : undefined; })();
  const textInline = (() => { const i = args.indexOf("--text");       return i >= 0 ? args[i + 1] : undefined; })();
  if (textFile) {
    if (!existsSync(textFile)) throw new Error(`File not found: ${textFile}`);
    const text = (await readFileProm(textFile)).toString("utf-8");
    if (text.length === 0) throw new Error("Text file is empty");
    if (new TextEncoder().encode(text).length > 8192) throw new Error("Input exceeds 8192 bytes");
    return text;
  }
  if (textInline) return textInline;
  throw new Error("Provide --text-file <path> or --text <text>");
}

async function confirm(prompt: string, timeoutMs: number): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const timer = setTimeout(() => { rl.close(); console.log("\nTimed out — aborting."); resolve(false); }, timeoutMs);
    process.stdout.write(prompt);
    rl.once("line", (answer) => { clearTimeout(timer); rl.close(); resolve(answer.trim().toLowerCase() === "yes"); });
  });
}

// ── Retry fulfillment path ─────────────────────────────────────────────────

async function retryV2Fulfillment(
  requestId: `0x${string}`,
  config: ReturnType<typeof loadAgentConfig>,
  providerApiUrl: string,
): Promise<void> {
  const record = await loadRecovery(requestId);
  if (!record) throw new Error(`No recovery record for requestId ${requestId}`);
  console.log(`\nFound recovery record — retrying /api/fulfill/v2 for requestId ${requestId}`);
  console.log(`  Tx hash: ${record.txHash}`);

  const res = await fetch(`${providerApiUrl}/api/fulfill/v2`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: record.input, quote: record.quote, txHash: record.txHash }),
  });
  const body = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error(`/api/fulfill/v2 error ${res.status}: ${body.error ?? JSON.stringify(body)}`);

  await deleteRecovery(requestId);
  const payment = body.payment as Record<string, unknown>;
  printInsights(body.result as Record<string, unknown>, payment.explorerUrl as string, record.txHash);
  console.log("\nRecovery complete — recovery file deleted.");
}

// ── Main V2 flow ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  printBanner();
  console.log("[V2 MODE] BudgetRailV2 with 0.5% platform fee\n");

  const config = loadAgentConfig();

  // Load V2-specific env
  let v2ContractAddress: `0x${string}`;
  let v2TreasuryAddress: `0x${string}`;
  try {
    v2ContractAddress = requireV2Env("BUDGET_RAIL_V2_ADDRESS").toLowerCase() as `0x${string}`;
    v2TreasuryAddress = requireV2Env("BUDGET_RAIL_V2_TREASURY").toLowerCase() as `0x${string}`;
  } catch (e) {
    printError((e as Error).message);
    process.exit(1);
  }

  console.log(`Network:      ${config.network} (chain ${config.chainId})`);
  console.log(`V2 contract:  ${v2ContractAddress}`);
  console.log(`V2 treasury:  ${v2TreasuryAddress}`);
  console.log(`Provider:     ${config.providerPayoutAddress}`);
  console.log(`Signer D:     ${config.quoteSignerAddress}`);
  console.log();

  const cliArgs = parseArgs();

  // ── Retry path ─────────────────────────────────────────────────────────
  if (cliArgs.retryRequestId) {
    await retryV2Fulfillment(cliArgs.retryRequestId, config, config.providerApiUrl);
    return;
  }

  // ── Normal path ────────────────────────────────────────────────────────

  let input: string;
  try { input = await resolveInput(); }
  catch (e) { printError((e as Error).message); process.exit(1); }

  const publicClient  = makePublicClient(config);
  const [walletClient, agentAddress] = makeWalletClient(config);
  console.log(`Agent wallet: ${agentAddress}\n`);

  // 1. Check provider health (includes V2 config validation)
  console.log("Checking provider API health...");
  try {
    const health = await fetch(`${config.providerApiUrl}/api/health`).then(r => r.json()) as Record<string, unknown>;
    if (health.status !== "ok") throw new Error(`Provider health: ${health.error ?? "degraded"}`);
    if (!health.v2Enabled) throw new Error("Provider does not have V2 enabled (BUDGET_RAIL_V2_ADDRESS not configured)");
    printSuccess("Provider API healthy with V2 enabled");
    if (health.v2Treasury && (health.v2Treasury as string).toLowerCase() !== v2TreasuryAddress.toLowerCase()) {
      throw new Error(
        `Treasury mismatch: provider health reports ${health.v2Treasury}, ` +
        `but BUDGET_RAIL_V2_TREASURY is ${v2TreasuryAddress}. ` +
        `Verify configuration before proceeding.`
      );
    }
  } catch (e) { printError((e as Error).message); process.exit(1); }
  console.log();

  // 2. Request V2 quote
  console.log("Requesting V2 quote from provider...");
  let quote: SignedQuoteV2;
  try {
    const res = await fetch(`${config.providerApiUrl}/api/quotes/v2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: cliArgs.sessionId.toString(), service: "document-insights-v1", input }),
    });
    const body = await res.json() as Record<string, unknown>;
    if (!res.ok) throw new Error(`/api/quotes/v2 error ${res.status}: ${body.error ?? JSON.stringify(body)}`);
    quote = body as unknown as SignedQuoteV2;
  } catch (e) { printError((e as Error).message); process.exit(1); }
  console.log();

  // 3. Pre-flight session checks (reads chain state)
  console.log("Running V2 pre-flight onchain checks...");
  const grossAmount = BigInt(quote.grossAmount);
  let preflightResult: Awaited<ReturnType<typeof verifySessionPreFlightV2>>;
  try {
    preflightResult = await verifySessionPreFlightV2(
      publicClient, v2ContractAddress, config,
      cliArgs.sessionId, agentAddress, grossAmount, v2TreasuryAddress,
    );
  } catch (e) { printError((e as Error).message); process.exit(1); }

  const { session, availableBalance } = preflightResult;
  console.log(`  Session owner:      ${session.owner}`);
  console.log(`  Session agent:      ${session.agent}`);
  console.log(`  Provider C:         ${session.provider}`);
  console.log(`  Quote signer D:     ${session.quoteSigner}`);
  console.log(`  Available balance:  ${availableBalance} micro-USDC`);
  console.log(`  Treasury E (chain): ${preflightResult.treasury}`);
  console.log(`  Fee BPS (chain):    ${preflightResult.feeBps} bps\n`);
  printSuccess("Pre-flight checks passed");
  console.log();

  // 4. Verify quote locally (EIP-712 + field checks)
  console.log("Verifying V2 quote locally...");
  try {
    await verifySignedQuoteV2({
      quote,
      sessionId:            cliArgs.sessionId,
      chainId:              config.chainId,
      contractAddress:      v2ContractAddress,
      providerPayoutAddress: config.providerPayoutAddress as `0x${string}`,
      expectedTreasury:     v2TreasuryAddress,
      quoteSignerAddress:   config.quoteSignerAddress as `0x${string}`,
      expectedBaseUnits:    BigInt(quote.baseAmount),
      perPaymentCap:        session.perPaymentCap,
      availableBalance,
    });
    printSuccess("V2 quote fully verified");
  } catch (e) { printError((e as Error).message); process.exit(1); }
  console.log();

  // 5. Display V2 price breakdown (always shown before any confirmation)
  const baseAmount = BigInt(quote.baseAmount);
  const feeAmount  = BigInt(quote.feeAmount);
  console.log("┌─────────────────────────────────────────────────────┐");
  console.log("│  V2 Payment Breakdown                                │");
  console.log("├─────────────────────────────────────────────────────┤");
  console.log(`│  Service price (base):  ${String(baseAmount).padStart(12)} micro-USDC     │`);
  console.log(`│  Platform fee (0.5%):   ${String(feeAmount).padStart(12)} micro-USDC     │`);
  console.log(`│  Gross total:           ${String(grossAmount).padStart(12)} micro-USDC     │`);
  console.log("├─────────────────────────────────────────────────────┤");
  console.log(`│  Provider C receives:   ${String(baseAmount).padStart(12)} micro-USDC     │`);
  console.log(`│  Treasury E receives:   ${String(feeAmount).padStart(12)} micro-USDC     │`);
  console.log("│                                                      │");
  console.log("│  NOTE: This is a MANUAL DEMO — you (the owner) are  │");
  console.log("│  acting as the agent by clicking Pay. This is NOT an │");
  console.log("│  autonomous agent transaction.                       │");
  console.log("└─────────────────────────────────────────────────────┘");
  console.log();

  // 6. Estimate gas
  console.log("Estimating gas...");
  let gasEstimate = 0n;
  try {
    gasEstimate = await estimatePayForRequestV2Gas(
      publicClient, v2ContractAddress, agentAddress,
      cliArgs.sessionId, baseAmount, feeAmount,
      quote.requestId as `0x${string}`,
      BigInt(quote.deadline),
      quote.signature,
    );
    console.log(`  Estimated gas: ${gasEstimate} units (native USDC, 18 decimals)`);
    if (preflightResult.nativeBalance < MIN_GAS_NATIVE_UNITS + gasEstimate) {
      printWarning("Native USDC balance may be too low to cover gas. Proceeding anyway.");
    }
  } catch (e) {
    printWarning(`Gas estimation failed: ${(e as Error).message}. Will proceed anyway.`);
  }
  console.log();

  if (cliArgs.dryRun) {
    console.log("DRY RUN: stopping before transaction submission.");
    process.exit(0);
  }

  // 7. Operator confirmation
  if (!cliArgs.noConfirm) {
    const prompt =
      `\nConfirm V2 payment:\n` +
      `  Base: ${baseAmount} micro-USDC → provider ${session.provider}\n` +
      `  Fee:  ${feeAmount} micro-USDC → treasury ${preflightResult.treasury}\n` +
      `  Gross: ${grossAmount} micro-USDC debited from session budget\n` +
      `  Gas:  ~${gasEstimate} units from native USDC\n\n` +
      `Type "yes" to confirm, anything else to abort: `;
    const approved = await confirm(prompt, config.confirmTimeoutMs);
    if (!approved) {
      console.log("\nAborted by operator. No transaction submitted.");
      process.exit(0);
    }
  }

  // 8. Save recovery metadata BEFORE broadcasting
  const recoveryPath = await saveRecovery({
    version:         1,
    createdAt:       new Date().toISOString(),
    sessionId:       cliArgs.sessionId.toString(),
    requestId:       quote.requestId as `0x${string}`,
    txHash:          "0x" as `0x${string}`,
    input,
    quote,
    network:         config.network,
    contractAddress: v2ContractAddress,
    explorerTxUrl:   "",
  });
  console.log(`\nRecovery metadata saved to: ${recoveryPath}`);

  // 9. Submit payForRequestV2
  console.log("\nSubmitting payForRequestV2 transaction...");
  let txHash: `0x${string}`;
  try {
    txHash = await submitPayForRequestV2(
      walletClient, v2ContractAddress,
      cliArgs.sessionId, baseAmount, feeAmount,
      quote.requestId as `0x${string}`,
      BigInt(quote.deadline),
      quote.signature,
    );
  } catch (e) {
    printError(
      `Transaction submission failed: ${(e as Error).message}\n` +
      `Recovery file preserved at ${recoveryPath} — check RPC state before retrying.`
    );
    process.exit(1);
  }

  // 10. Update recovery with real txHash
  await saveRecovery({
    version: 1, createdAt: new Date().toISOString(),
    sessionId: cliArgs.sessionId.toString(),
    requestId: quote.requestId as `0x${string}`,
    txHash, input, quote, network: config.network,
    contractAddress: v2ContractAddress,
    explorerTxUrl: `${config.explorerBase}/tx/${txHash}`,
  });

  console.log(`\nTx submitted: ${config.explorerBase}/tx/${txHash}`);

  // 11. Wait for receipt
  let receipt: Awaited<ReturnType<typeof waitForReceipt>>;
  try {
    receipt = await waitForReceipt(publicClient, txHash, (msg) => console.log(msg));
  } catch (e) {
    printError(
      `${(e as Error).message}\n` +
      `Recovery file preserved: ${recoveryPath}\n` +
      `To resume: pnpm agent:v2 --session ${cliArgs.sessionId} --retry-request-id ${quote.requestId}`
    );
    process.exit(1);
  }

  if (receipt.status !== "success") {
    printError(`Transaction reverted (status=${receipt.status}). Payment NOT settled. Recovery deleted.`);
    await deleteRecovery(quote.requestId as `0x${string}`);
    process.exit(1);
  }

  console.log(`\nReceipt confirmed at block ${receipt.blockNumber}, gas used: ${receipt.gasUsed}`);

  // 12. Verify PaymentSettledV2 log
  const settled = findPaymentSettledV2Log(receipt, v2ContractAddress, quote.requestId as `0x${string}`);
  if (!settled) {
    printError("PaymentSettledV2 event not found in receipt. Recovery file preserved for manual investigation.");
    process.exit(1);
  }

  console.log(`\nPaymentSettledV2:`);
  console.log(`  Session:  ${settled.sessionId}`);
  console.log(`  Provider: ${settled.provider} received ${settled.baseAmount} micro-USDC (base)`);
  console.log(`  Treasury: ${settled.treasury} received ${settled.feeAmount} micro-USDC (fee)`);
  console.log(`  Gross:    ${settled.grossAmount} micro-USDC debited from session`);
  console.log(`  Remaining balance: ${settled.remainingBalance} micro-USDC`);
  printSuccess("V2 payment settled and verified onchain");

  // 13. Call /api/fulfill/v2
  console.log("\nCalling /api/fulfill/v2...");
  let fulfillResult: Record<string, unknown>;
  try {
    const res = await fetch(`${config.providerApiUrl}/api/fulfill/v2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input, quote, txHash }),
    });
    fulfillResult = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      const retryable = (fulfillResult as { retryable?: boolean }).retryable;
      if (retryable) {
        printWarning(
          `${fulfillResult.error}\n\n` +
          `Payment is settled onchain. Retry /api/fulfill/v2 later:\n` +
          `  pnpm agent:v2 --session ${cliArgs.sessionId} --retry-request-id ${quote.requestId}`
        );
        process.exit(0);
      }
      throw new Error(`/api/fulfill/v2 ${res.status}: ${fulfillResult.error}`);
    }
  } catch (e) {
    printError(
      `Fulfillment failed: ${(e as Error).message}\n` +
      `Payment settled onchain. Recovery file preserved. Retry:\n` +
      `  pnpm agent:v2 --session ${cliArgs.sessionId} --retry-request-id ${quote.requestId}`
    );
    process.exit(1);
  }

  // 14. Done
  await deleteRecovery(quote.requestId as `0x${string}`);
  const payment = fulfillResult.payment as Record<string, unknown>;
  printInsights(fulfillResult.result as Record<string, unknown>, payment.explorerUrl as string, txHash);
  console.log(`\n\x1b[32mV2 payment complete. Recovery file deleted.\x1b[0m\n`);
}

main().catch((e) => { printError(String(e)); process.exit(1); });
