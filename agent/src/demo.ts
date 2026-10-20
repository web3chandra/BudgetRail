#!/usr/bin/env bun
/**
 * BudgetRail Agent Demo CLI
 *
 * Usage:
 *   pnpm agent:demo --session 1 --text-file ./samples/document.txt
 *   pnpm agent:demo --session 1 --text "Hello world"
 *   pnpm agent:demo --session 1 --text-file ./samples/document.txt --dry-run
 *
 * Required env (set in ~/.budgetrail/agent.env or equivalent, NEVER in .env committed to git):
 *   AGENT_PRIVATE_KEY           — 0x-prefixed key of wallet B
 *   PROVIDER_API_URL            — e.g. http://localhost:3001
 *   BUDGET_RAIL_PROVIDER_PAYOUT — provider payout address C
 *   BUDGET_RAIL_QUOTE_SIGNER    — quote signer address D
 *
 * Safety guarantees:
 *   - Requests OPERATOR CONFIRMATION before any onchain spend (unless --no-confirm)
 *   - Checks receipt and PaymentSettled event before calling /api/fulfill
 *   - Saves recovery metadata BEFORE broadcasting; never blindly retries a payment
 *   - Never retries the onchain transaction; only retries /api/fulfill
 *   - Does not loop or auto-spend; each invocation is a single, operator-controlled payment
 */

import { readFile as readFileNode, existsSync } from "node:fs";
import { promisify } from "node:util";
import * as readline from "node:readline";
import { loadAgentConfig } from "./lib/config.js";
import {
  makePublicClient, makeWalletClient,
  verifySessionPreFlight,
  estimatePayForRequestGas,
  submitPayForRequest,
  waitForReceipt,
  findPaymentSettledLog,
} from "./lib/chain.js";
import { verifySignedQuote } from "./lib/eip712.js";
import { saveRecovery, loadRecovery, deleteRecovery } from "./lib/recovery.js";
import { checkProviderHealth, requestQuote, submitFulfillment, RetryableFulfillError } from "./lib/provider.js";
import {
  printBanner, printSessionChecks, printQuotePreview,
  printGasEstimate, printConfirmPrompt, printTxSubmitted,
  printReceiptConfirmed, printPaymentSettled, printInsights,
  printError, printWarning, printSuccess,
} from "./lib/display.js";
import { FIXED_PRICE_UNITS } from "./lib/constants.js";

const readFileProm = promisify(readFileNode);

// ── CLI argument parsing ───────────────────────────────────────────────────

interface CliArgs {
  sessionId:  bigint;
  input:      string;
  dryRun:     boolean;
  noConfirm:  boolean;
  retryRequestId?: `0x${string}`;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const get  = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const sessionStr = get("--session");
  if (!sessionStr) {
    console.error("Usage: pnpm agent:demo --session <id> --text-file <path> [--dry-run] [--no-confirm]");
    console.error("       pnpm agent:demo --session <id> --text <text> [--dry-run]");
    console.error("       pnpm agent:demo --session <id> --retry-request-id <0xhex>");
    process.exit(1);
  }

  const sessionId = BigInt(sessionStr);
  const dryRun    = args.includes("--dry-run");
  const noConfirm = args.includes("--no-confirm");
  const retryId   = get("--retry-request-id") as `0x${string}` | undefined;

  return { sessionId, input: "", dryRun, noConfirm, retryRequestId: retryId };
}

async function resolveInput(_args: Partial<CliArgs>): Promise<string> {
  const cliArgs = process.argv.slice(2);
  const textFile = (() => { const i = cliArgs.indexOf("--text-file"); return i >= 0 ? cliArgs[i + 1] : undefined; })();
  const textInline = (() => { const i = cliArgs.indexOf("--text"); return i >= 0 ? cliArgs[i + 1] : undefined; })();

  if (textFile) {
    if (!existsSync(textFile)) {
      throw new Error(`File not found: ${textFile}`);
    }
    const buf = await readFileProm(textFile);
    const text = buf.toString("utf-8");
    if (text.length === 0) throw new Error("Text file is empty");
    if (new TextEncoder().encode(text).length > 8192) {
      throw new Error("Input exceeds 8192 bytes — provider will reject");
    }
    return text;
  }
  if (textInline) {
    return textInline;
  }
  throw new Error("Provide --text-file <path> or --text <text>");
}

// ── Operator confirmation ──────────────────────────────────────────────────

async function confirm(prompt: string, timeoutMs: number): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      rl.close();
      console.log("\nTimed out waiting for confirmation — aborting.");
      resolve(false);
    }, timeoutMs);

    process.stdout.write(prompt);
    rl.once("line", (answer) => {
      clearTimeout(timer);
      rl.close();
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}

// ── Retry-fulfillment path ─────────────────────────────────────────────────

async function retryFulfillment(
  requestId: `0x${string}`,
  config: ReturnType<typeof loadAgentConfig>,
): Promise<void> {
  const record = await loadRecovery(requestId);
  if (!record) {
    throw new Error(`No recovery record found for requestId ${requestId}`);
  }
  console.log(`\nFound recovery record — retrying /api/fulfill for requestId ${requestId}`);
  console.log(`  Tx hash: ${record.txHash}`);
  console.log(`  Network: ${record.network}`);

  const result = await submitFulfillment(config, {
    input:  record.input,
    quote:  record.quote,
    txHash: record.txHash,
  });

  await deleteRecovery(requestId);
  printInsights(result.insights, result.explorerUrl, result.txHash);
  console.log("\nRecovery complete — recovery file deleted.");
}

// ── Main demo flow ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  printBanner();

  // 1. Load config (fails fast if env vars are missing)
  const config = loadAgentConfig();
  console.log(`Network: ${config.network} (chain ${config.chainId})`);
  console.log(`Contract: ${config.contractAddress}`);
  console.log();

  const cliArgs = parseArgs();

  // ── Retry path ──────────────────────────────────────────────────────────
  if (cliArgs.retryRequestId) {
    await retryFulfillment(cliArgs.retryRequestId, config);
    return;
  }

  // ── Normal path ─────────────────────────────────────────────────────────

  // 2. Resolve input text
  let input: string;
  try {
    input = await resolveInput(cliArgs);
  } catch (err) {
    printError((err as Error).message);
    process.exit(1);
  }

  const inputBytes = new TextEncoder().encode(input).length;
  console.log(`Input: ${inputBytes} bytes, first 80 chars: "${input.slice(0, 80).replace(/\n/g, "\\n")}"`);
  console.log();

  // 3. Build onchain clients
  const publicClient = makePublicClient(config);
  const [walletClient, agentAddress] = makeWalletClient(config);

  console.log(`Agent wallet: ${agentAddress}`);

  // 4. Pre-flight session checks
  console.log("Running pre-flight onchain checks...\n");
  let checks: Awaited<ReturnType<typeof verifySessionPreFlight>>;
  try {
    checks = await verifySessionPreFlight(
      publicClient, config, cliArgs.sessionId, agentAddress, FIXED_PRICE_UNITS
    );
  } catch (err) {
    printError((err as Error).message);
    process.exit(1);
  }
  printSessionChecks(checks, cliArgs.sessionId);

  // 5. Check provider health
  console.log("Checking provider API health...");
  try {
    await checkProviderHealth(config);
    printSuccess("Provider API is healthy");
  } catch (err) {
    printError((err as Error).message);
    process.exit(1);
  }
  console.log();

  // 6. Request signed quote
  console.log("Requesting quote from provider...");
  let quote: Awaited<ReturnType<typeof requestQuote>>;
  try {
    quote = await requestQuote(config, {
      sessionId: cliArgs.sessionId.toString(),
      service:   "document-insights-v1",
      input,
    });
  } catch (err) {
    printError((err as Error).message);
    process.exit(1);
  }
  console.log();

  // 7. Locally verify quote
  console.log("Verifying quote locally (EIP-712 signature + field checks)...");
  try {
    await verifySignedQuote(
      quote,
      input,
      cliArgs.sessionId,
      config.chainId,
      config.contractAddress,
      config.providerPayoutAddress,
      config.quoteSignerAddress,
      FIXED_PRICE_UNITS,
    );
    printSuccess("Quote fully verified");
  } catch (err) {
    printError((err as Error).message);
    process.exit(1);
  }
  console.log();
  printQuotePreview(quote, cliArgs.sessionId);

  // 8. Estimate gas
  console.log("Estimating gas...");
  let gasEstimate = 0n;
  try {
    gasEstimate = await estimatePayForRequestGas(
      publicClient, config, agentAddress,
      cliArgs.sessionId,
      quote.requestId as `0x${string}`,
      quote.requestHash as `0x${string}`,
      BigInt(quote.amount),
      BigInt(quote.quoteDeadline),
      quote.signature,
    );
    printGasEstimate(gasEstimate);
  } catch (err) {
    printWarning(`Gas estimation failed: ${(err as Error).message}. Will proceed anyway.`);
    console.log();
  }

  if (cliArgs.dryRun) {
    console.log("DRY RUN: stopping before transaction submission.");
    process.exit(0);
  }

  // 9. Operator confirmation
  if (!cliArgs.noConfirm) {
    const approved = await confirm(
      printConfirmPrompt(BigInt(quote.amount), gasEstimate),
      config.confirmTimeoutMs,
    );
    if (!approved) {
      console.log("\nAborted by operator. No transaction submitted.");
      process.exit(0);
    }
  }

  // 10. Save recovery metadata BEFORE broadcasting
  const recoveryPath = await saveRecovery({
    version:         1,
    createdAt:       new Date().toISOString(),
    sessionId:       cliArgs.sessionId.toString(),
    requestId:       quote.requestId as `0x${string}`,
    txHash:          "0x" as `0x${string}`, // placeholder — filled after submission
    input,
    quote,
    network:         config.network,
    contractAddress: config.contractAddress,
    explorerTxUrl:   "",
  });
  console.log(`\nRecovery metadata saved to: ${recoveryPath}`);

  // 11. Submit payForRequest from agent wallet B
  console.log("\nSubmitting payForRequest transaction...");
  let txHash: `0x${string}`;
  try {
    txHash = await submitPayForRequest(
      walletClient, config,
      cliArgs.sessionId,
      quote.requestId as `0x${string}`,
      quote.requestHash as `0x${string}`,
      BigInt(quote.amount),
      BigInt(quote.quoteDeadline),
      quote.signature,
    );
  } catch (err) {
    printError(
      `Transaction submission failed: ${(err as Error).message}\n` +
      `Recovery file preserved at ${recoveryPath} — check RPC state before retrying.`
    );
    process.exit(1);
  }

  // 12. Update recovery record with real txHash
  await saveRecovery({
    version:         1,
    createdAt:       new Date().toISOString(),
    sessionId:       cliArgs.sessionId.toString(),
    requestId:       quote.requestId as `0x${string}`,
    txHash,
    input,
    quote,
    network:         config.network,
    contractAddress: config.contractAddress,
    explorerTxUrl:   `${config.explorerBase}/tx/${txHash}`,
  });

  printTxSubmitted(txHash, config.explorerBase);

  // 13. Wait for receipt
  let receipt: Awaited<ReturnType<typeof waitForReceipt>>;
  try {
    receipt = await waitForReceipt(publicClient, txHash, (msg) => console.log(msg));
  } catch (err) {
    printError(
      `${(err as Error).message}\n` +
      `Recovery file preserved: ${recoveryPath}\n` +
      `To resume: pnpm agent:demo --session ${cliArgs.sessionId} --retry-request-id ${quote.requestId}`
    );
    process.exit(1);
  }

  if (receipt.status !== "success") {
    printError(
      `Transaction reverted (status=${receipt.status}). ` +
      `The payment was NOT settled. Recovery file deleted (payment never happened).`
    );
    await deleteRecovery(quote.requestId as `0x${string}`);
    process.exit(1);
  }

  printReceiptConfirmed(receipt.blockNumber, receipt.gasUsed);

  // 14. Verify PaymentSettled log
  const settled = findPaymentSettledLog(
    receipt,
    config.contractAddress,
    quote.requestId as `0x${string}`,
  );
  if (!settled) {
    printError(
      "PaymentSettled event not found in receipt logs. ` +\n` +\n" +
      "This is unexpected — the receipt was successful. " +
      "Recovery file preserved for manual investigation."
    );
    process.exit(1);
  }
  printPaymentSettled(settled.sessionId, settled.amount, settled.provider);

  // 15. Call /api/fulfill
  console.log("\nCalling /api/fulfill...");
  let fulfillResult: Awaited<ReturnType<typeof submitFulfillment>>;
  try {
    fulfillResult = await submitFulfillment(config, { input, quote, txHash });
  } catch (err) {
    if (err instanceof RetryableFulfillError) {
      printWarning(
        `${err.message}\n\n` +
        `Payment is settled onchain. Retry /api/fulfill later:\n` +
        `  pnpm agent:demo --session ${cliArgs.sessionId} --retry-request-id ${quote.requestId} [text args not needed for retry]`
      );
      process.exit(0);
    }
    printError(
      `Fulfillment failed: ${(err as Error).message}\n` +
      `Payment is settled onchain. Recovery file preserved. Retry:\n` +
      `  pnpm agent:demo --session ${cliArgs.sessionId} --retry-request-id ${quote.requestId}`
    );
    process.exit(1);
  }

  // 16. Cleanup and display results
  await deleteRecovery(quote.requestId as `0x${string}`);
  printInsights(fulfillResult.insights, fulfillResult.explorerUrl, txHash);
  console.log(`\n${"\x1b[32m"}Complete. Recovery file deleted.${"\x1b[0m"}\n`);
}

main().catch((err) => {
  printError(String(err));
  process.exit(1);
});
