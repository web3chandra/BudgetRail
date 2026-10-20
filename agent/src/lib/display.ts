/**
 * Terminal display helpers for the agent demo CLI.
 * No external dependencies — uses ANSI escape codes and process.stdout.write.
 */

import type { SessionChecks } from "./chain.js";
import type { SignedQuote } from "./eip712.js";
import type { DocumentInsights } from "./provider.js";

// ── ANSI colour helpers ────────────────────────────────────────────────────

const R = "\x1b[0m";   // reset
const B = "\x1b[1m";   // bold
const D = "\x1b[2m";   // dim
const G = "\x1b[32m";  // green
const Y = "\x1b[33m";  // yellow
const C = "\x1b[36m";  // cyan
const E = "\x1b[31m";  // red (error)


function bold(s: string)  { return `${B}${s}${R}`; }
function green(s: string) { return `${G}${s}${R}`; }
function yellow(s: string){ return `${Y}${s}${R}`; }
function cyan(s: string)  { return `${C}${s}${R}`; }
function red(s: string)   { return `${E}${s}${R}`; }
function dim(s: string)   { return `${D}${s}${R}`; }

// ── Formatting ─────────────────────────────────────────────────────────────

/** Format uint96 ERC-20 USDC base units as "$0.000000" */
export function formatUsdc(units: bigint): string {
  const whole    = units / 1_000_000n;
  const fraction = units % 1_000_000n;
  return `$${whole}.${fraction.toString().padStart(6, "0")}`;
}

/** Format native-gas-USDC (18 dec) as "$0.000000000000000000" but only show 6 sig frac digits */
export function formatNativeUsdc(units: bigint): string {
  const scale = 10n ** 18n;
  const whole    = units / scale;
  const fraction = (units % scale) / (10n ** 12n); // convert to 6-dec
  return `$${whole}.${fraction.toString().padStart(6, "0")} (gas view)`;
}

export function formatAddress(addr: string): string {
  return `${addr.slice(0, 10)}...${addr.slice(-8)}`;
}

export function formatTimestamp(ts: bigint): string {
  return new Date(Number(ts) * 1000).toISOString();
}

// ── Display sections ───────────────────────────────────────────────────────

export function printBanner(): void {
  console.log(`
${B}${C}╔════════════════════════════════════════════╗
║         BudgetRail Agent CLI Demo          ║
╚════════════════════════════════════════════╝${R}
${D}Arc Testnet — real onchain transactions${R}
`);
}

export function printSessionChecks(checks: SessionChecks, sessionId: bigint): void {
  const s = checks.session;
  const secsLeft = Number(s.expiresAt) - Math.floor(Date.now() / 1000);
  const minsLeft = Math.max(0, Math.floor(secsLeft / 60));

  console.log(bold("Pre-flight checks passed:"));
  console.log(`  Session ID       ${cyan(sessionId.toString())}`);
  console.log(`  Agent wallet     ${cyan(checks.agentAddress)}`);
  console.log(`  Session agent    ${green("matches")} ${dim(checks.agentAddress)}`);
  console.log(`  Provider         ${formatAddress(s.provider)}`);
  console.log(`  Quote signer     ${formatAddress(s.quoteSigner)}`);
  console.log(`  Max budget       ${formatUsdc(s.maxBudget)}`);
  console.log(`  Per-call cap     ${formatUsdc(s.perPaymentCap)}`);
  console.log(`  Total funded     ${formatUsdc(s.totalFunded)}`);
  console.log(`  Total spent      ${formatUsdc(s.totalSpent)}`);
  console.log(`  Available        ${formatUsdc(checks.availableBalance)}`);
  console.log(`  Session expiry   ${formatTimestamp(s.expiresAt)} ${dim(`(${minsLeft}m remaining)`)}`);
  console.log(`  USDC balance     ${formatUsdc(checks.usdcBalance)}`);
  console.log(`  Gas balance      ${formatNativeUsdc(checks.nativeBalance)}`);
  console.log();
}

export function printQuotePreview(quote: SignedQuote, _sessionId: bigint): void {
  const deadline = new Date(Number(quote.quoteDeadline) * 1000).toISOString();
  const secsLeft = Number(quote.quoteDeadline) - Math.floor(Date.now() / 1000);

  console.log(bold("Quote received and verified:"));
  console.log(`  Service          ${cyan(quote.service)}`);
  console.log(`  Request ID       ${dim(formatAddress(quote.requestId))}`);
  console.log(`  Request hash     ${dim(formatAddress(quote.requestHash))}`);
  console.log(`  USDC charge      ${green(quote.displayPrice ?? formatUsdc(BigInt(quote.amount)))}`);
  console.log(`  Provider payout  ${formatAddress(quote.providerPayout)}`);
  console.log(`  Quote signer     ${formatAddress(quote.quoteSignerAddress)}`);
  console.log(`  Deadline         ${deadline} ${dim(`(${secsLeft}s from now)`)}`);
  console.log(`  Signature        ${green("EIP-712 verified")}`);
  console.log(`  SHA-256 hash     ${green("matches server hash")}`);
  console.log();
}

export function printGasEstimate(gasUnits: bigint, gasPriceGwei?: bigint): void {
  const gpStr = gasPriceGwei ? `${gasPriceGwei} gwei` : "unknown";
  console.log(bold("Gas estimate:"));
  console.log(`  Gas units        ${cyan(gasUnits.toString())}`);
  console.log(`  Gas price        ${dim(gpStr)}`);
  console.log(`  Note: on Arc, gas is paid in USDC (native 18-dec), NOT a separate token`);
  console.log();
}

export function printConfirmPrompt(
  usdcCharge: bigint,
  gasUnits: bigint,
): string {
  return (
    bold(yellow("\nABOUT TO SPEND ONCHAIN USDC:")) + "\n" +
    `  USDC payment  ${red(formatUsdc(usdcCharge))} to provider\n` +
    `  Gas cost      ${yellow(`~${gasUnits} gas units`)} (native USDC, 18-dec)\n` +
    `  Chain         Arc Testnet (chain ID 5042002) — testnet only\n\n` +
    bold("Type \"yes\" to confirm and submit, anything else to abort: ")
  );
}

export function printTxSubmitted(txHash: string, explorerBase: string): void {
  console.log(`\n${green("Transaction submitted:")}`);
  console.log(`  Hash   ${cyan(txHash)}`);
  console.log(`  View   ${C}${explorerBase}/tx/${txHash}${R}`);
  console.log(`${dim("Waiting for receipt (polling every 2s)...")}`);
  console.log();
}

export function printReceiptConfirmed(blockNumber: bigint, gasUsed: bigint): void {
  console.log(`${green("Receipt confirmed:")} block ${blockNumber}, gas used ${gasUsed}`);
}

export function printPaymentSettled(
  sessionId: bigint,
  amount: bigint,
  provider: string,
): void {
  console.log(green("\nPaymentSettled event verified:"));
  console.log(`  Session    ${sessionId}`);
  console.log(`  Amount     ${formatUsdc(amount)}`);
  console.log(`  Provider   ${formatAddress(provider)}`);
}

export function printInsights(insights: DocumentInsights, explorerUrl: string, txHash: string): void {
  console.log(`\n${bold(green("Document Insights (from provider API — verified receipt):"))}
`);
  console.log(`  Word count        ${bold(insights.wordCount.toString())}`);
  console.log(`  Sentence count    ${bold(insights.sentenceCount.toString())}`);
  console.log(`  Paragraph count   ${bold(insights.paragraphCount.toString())}`);
  console.log(`  Character count   ${bold(insights.characterCount.toString())}`);
  console.log(`  Avg words/sent    ${insights.avgWordsPerSentence.toFixed(1)}`);
  console.log(`  Readability       ${cyan(insights.readabilityTier)}`);

  if (insights.extractiveSummary.length) {
    console.log(`\n  Summary:`);
    for (const s of insights.extractiveSummary) {
      console.log(`    ${dim("•")} ${s}`);
    }
  }

  if (insights.top10Keywords.length) {
    console.log(`\n  Top keywords:`);
    const kws = insights.top10Keywords.slice(0, 5)
      .map(k => `${k.word}(${k.count})`).join("  ");
    console.log(`    ${cyan(kws)}`);
  }

  console.log(`\n  ${bold("Explorer:  ")}${C}${explorerUrl}${R}`);
  console.log(`  ${bold("Tx hash:   ")}${dim(txHash)}`);
}

export function printError(message: string): void {
  console.error(`\n${red("Error:")} ${message}`);
}

export function printWarning(message: string): void {
  console.warn(`${yellow("Warning:")} ${message}`);
}

export function printSuccess(message: string): void {
  console.log(`${green("OK")} ${message}`);
}
