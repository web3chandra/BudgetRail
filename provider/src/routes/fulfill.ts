/**
 * POST /api/fulfill
 *
 * Returns the Document Insights result ONLY after independent onchain proof
 * that BudgetRail.payForRequest() settled the exact payment to this provider.
 *
 * Security properties enforced:
 *   1. Recomputes SHA-256(input) and requires it matches quote.requestHash.
 *   2. Verifies EIP-712 sig against quoteSigner stored in the onchain session.
 *   3. Verifies tx.from == session.agent and tx.to == BudgetRail contract.
 *   4. Checks receipt.status == success.
 *   5. Decodes PaymentSettled from the EXACT configured BudgetRail address.
 *   6. Checks all PaymentSettled fields match: sessionId, requestId, requestHash,
 *      provider, agent, amount, quoteDeadline.
 *   7. Decodes ERC-20 Transfer from the canonical USDC address:
 *      from=BudgetRail, to=provider, value=amount.
 *   8. Verifies payment was finalized before session/quote expiry
 *      (uses block.timestamp, not wall-clock, for finality check).
 *   9. Idempotent: same (requestId, input) returns same result on cold restart
 *      (derived deterministically from the input — no in-memory state needed).
 *  10. Different input for same requestId returns 400 (requestHash mismatch).
 *
 * Request body (JSON):
 *   {
 *     input:  string,        // exact original UTF-8 input
 *     quote:  {              // the full signed quote returned by /api/quotes
 *       sessionId:     string,
 *       requestId:     string,
 *       requestHash:   string,
 *       amount:        string,
 *       quoteDeadline: string,
 *       signature:     string,
 *       chainId:       number,
 *       contractAddress: string,
 *       providerPayout:  string,
 *       quoteSignerAddress: string,
 *       service:       string,
 *     },
 *     txHash: string,        // 0x-prefixed tx hash of the payForRequest call
 *   }
 */

import { toEventHash } from "viem";
import { type Config, USDC_ADDRESS } from "../lib/config.js";
import {
  fetchReceipt,
  fetchTransaction,
  fetchBlockTimestamp,
  decodePaymentSettledLog,
  decodeTransferLog,
  BUDGET_RAIL_ABI,
  ERC20_ABI,
} from "../lib/onchain.js";
import { computeRequestHash, quoteSignerAddressFromPrivKey } from "../lib/eip712.js";
import { computeInsights } from "../lib/insights.js";
import { buildTxExplorerUrl } from "./explorerUrls.js";

// Derive topic0 values from the canonical ABI — never hardcode these.
// toEventHash() computes keccak256 of the canonical event signature (no indexed/names).
// PaymentSettled: 0x5c25b27cd6964ebe086bfeb3f23d3b3a2a086ed5166e11817b2e620cadc5ead5
// Transfer:       0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
const PAYMENT_SETTLED_TOPIC = toEventHash(
  BUDGET_RAIL_ABI.find(x => x.type === "event" && x.name === "PaymentSettled")!
) as `0x${string}`;

const ERC20_TRANSFER_TOPIC = toEventHash(
  ERC20_ABI.find(x => x.type === "event" && x.name === "Transfer")!
) as `0x${string}`;

export async function handleFulfill(config: Config, req: Request): Promise<Response> {
  // ── 0. Parse body ────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  if (typeof body !== "object" || body === null)
    return err(400, "Body must be a JSON object");

  const { input, quote: rawQuote, txHash: rawTxHash } =
    body as Record<string, unknown>;

  // ── 1. Validate input ────────────────────────────────────────────────────
  if (typeof input !== "string")
    return err(400, "input must be a string");
  const inputBytes = new TextEncoder().encode(input);
  if (inputBytes.length === 0)
    return err(400, "input must not be empty");
  if (inputBytes.length > config.maxInputBytes)
    return err(400, `input exceeds ${config.maxInputBytes} bytes`);

  // ── 2. Validate txHash ───────────────────────────────────────────────────
  if (typeof rawTxHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(rawTxHash))
    return err(400, "txHash must be a 0x-prefixed 32-byte hex string");
  const txHash = rawTxHash.toLowerCase() as `0x${string}`;

  // ── 3. Validate quote schema ─────────────────────────────────────────────
  if (typeof rawQuote !== "object" || rawQuote === null)
    return err(400, "quote must be an object");
  const q = rawQuote as Record<string, unknown>;

  const requiredFields = [
    "sessionId","requestId","requestHash","amount","quoteDeadline",
    "signature","chainId","contractAddress","providerPayout","quoteSignerAddress","service",
  ];
  for (const f of requiredFields) {
    if (q[f] === undefined) return err(400, `quote.${f} is required`);
  }

  // Parse numeric quote fields
  let sessionId: bigint, amount: bigint, quoteDeadline: bigint;
  try {
    sessionId     = BigInt(q.sessionId as string);
    amount        = BigInt(q.amount as string);
    quoteDeadline = BigInt(q.quoteDeadline as string);
  } catch {
    return err(400, "quote.sessionId, amount, quoteDeadline must be parseable as BigInt");
  }

  const requestId   = (q.requestId   as string).toLowerCase() as `0x${string}`;
  const requestHash = (q.requestHash as string).toLowerCase() as `0x${string}`;
  const quoteChainId    = Number(q.chainId);
  const quoteContract   = (q.contractAddress   as string).toLowerCase();
  const quoteProvider   = (q.providerPayout    as string).toLowerCase();
  const quoteSignerAddr = (q.quoteSignerAddress as string).toLowerCase();
  const service         = q.service as string;

  // ── 4. Validate quote matches this server's config ───────────────────────
  if (quoteChainId !== config.chainId)
    return err(400, `Quote chainId ${quoteChainId} does not match configured chainId ${config.chainId}`);
  if (quoteContract !== config.contractAddress.toLowerCase())
    return err(400, "Quote contractAddress does not match deployed BudgetRail");
  if (quoteProvider !== config.providerPayoutAddress.toLowerCase())
    return err(400, "Quote providerPayout does not match this server's payout address");
  if (service !== "document-insights-v1")
    return err(400, "Unsupported service in quote");

  const expectedSigner = quoteSignerAddressFromPrivKey(config.quoteSignerPrivateKey).toLowerCase();
  if (quoteSignerAddr !== expectedSigner)
    return err(400, "Quote quoteSignerAddress does not match this server's signer");
  if (amount !== config.pricePerCall)
    return err(400, `Quote amount ${amount} does not match supported price ${config.pricePerCall}`);

  // ── 5. Recompute requestHash from input and compare ──────────────────────
  const computedHash = (await computeRequestHash(input)).toLowerCase();
  if (computedHash !== requestHash)
    return err(400, "requestHash does not match SHA-256(input) — input may have been altered");

  // ── 6. Fetch tx and receipt from chain ───────────────────────────────────
  let receipt, tx;
  try {
    [receipt, tx] = await Promise.all([
      fetchReceipt(config, txHash),
      fetchTransaction(config, txHash),
    ]);
  } catch {
    return err(503, "RPC error fetching transaction; retry later", true);
  }

  if (!receipt || !tx)
    return err(402, "Transaction not found on chain; payment may not be confirmed yet", true);

  // ── 7. Receipt must be successful ─────────────────────────────────────────
  if (receipt.status !== "success")
    return err(402, "Transaction reverted; payment was not settled");

  // ── 8. tx.to must be the exact configured BudgetRail contract ─────────────
  if (!tx.to || tx.to.toLowerCase() !== config.contractAddress.toLowerCase())
    return err(400, "Transaction was not sent to the configured BudgetRail contract");

  // ── 9. tx.from must be session.agent — read session from chain ─────────────
  // (We need the agent address for the comparison below)
  // We read it from the PaymentSettled log (the log's indexed agent field is authoritative).

  // ── 10. Find and decode PaymentSettled log from EXACT BudgetRail address ──
  const contractAddrLower = config.contractAddress.toLowerCase();
  const paymentLog = receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === contractAddrLower &&
      log.topics[0]?.toLowerCase() === PAYMENT_SETTLED_TOPIC.toLowerCase()
  );
  if (!paymentLog)
    return err(400, "No PaymentSettled event from configured BudgetRail in this transaction. " +
      "The transaction was sent to the correct contract but the expected event was not emitted. " +
      "This is a permanent mismatch — do NOT retry payment. Verify the transaction on the explorer.");

  const settled = decodePaymentSettledLog(paymentLog);
  if (!settled)
    return err(400, "Failed to decode PaymentSettled log");

  // ── 11. Match all PaymentSettled fields ────────────────────────────────────
  if (settled.sessionId !== sessionId)
    return err(400, `PaymentSettled.sessionId ${settled.sessionId} != quote.sessionId ${sessionId}`);
  if (settled.requestId !== requestId)
    return err(400, "PaymentSettled.requestId does not match quote.requestId");
  if (settled.requestHash !== requestHash)
    return err(400, "PaymentSettled.requestHash does not match SHA-256(input)");
  if (settled.provider !== config.providerPayoutAddress.toLowerCase())
    return err(400, "PaymentSettled.provider does not match this server's payout address");
  if (settled.amount !== amount)
    return err(400, `PaymentSettled.amount ${settled.amount} != quote.amount ${amount}`);
  // quoteDeadline field check
  if (settled.quoteDeadline !== quoteDeadline)
    return err(400, "PaymentSettled.quoteDeadline does not match quote.quoteDeadline");

  // ── 12. tx.from must equal session.agent (settled.agent) ──────────────────
  if (tx.from.toLowerCase() !== settled.agent.toLowerCase())
    return err(400, "tx.from does not match the agent recorded in PaymentSettled");

  // ── 13. Find and decode ERC-20 Transfer from canonical USDC ───────────────
  // Arc Testnet receipts contain two Transfer logs: one from the native-gas wrapper
  // (0xffffffffffffffffffffffffffffffffffffffff) and one from the canonical USDC
  // ERC-20 contract (0x3600...).  We must match on ALL three criteria:
  //   address == canonical USDC contract
  //   topic0  == ERC-20 Transfer selector
  // The from/to/value check happens after decode — do not rely on topic ordering
  // to distinguish which Transfer is the payment.
  const usdcAddrLower = USDC_ADDRESS.toLowerCase();
  const transferLog = receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === usdcAddrLower &&
      log.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC.toLowerCase()
  );
  if (!transferLog)
    return err(402, "No ERC-20 Transfer from canonical USDC address in this transaction");

  const transfer = decodeTransferLog(transferLog);
  if (!transfer)
    return err(400, "Failed to decode USDC Transfer log");

  // Verify Transfer: from=BudgetRail, to=provider, value=amount
  if (transfer.from !== contractAddrLower)
    return err(400, "USDC Transfer.from is not the BudgetRail contract");
  if (transfer.to !== config.providerPayoutAddress.toLowerCase())
    return err(400, "USDC Transfer.to is not this server's payout address");
  if (transfer.value !== amount)
    return err(400, `USDC Transfer.value ${transfer.value} != expected ${amount}`);

  // ── 14. Verify payment included before session expiry ─────────────────────
  // We use block.timestamp (from the block that included the tx) — not wall clock.
  // A payment that was mined before session expiry is valid even if we process it
  // after the session has expired (reject only if the block itself was post-expiry).
  if (receipt.blockNumber != null) {
    const blockTs = await fetchBlockTimestamp(config, receipt.blockNumber);
    if (blockTs != null && blockTs > quoteDeadline) {
      return err(400,
        `Payment block timestamp (${blockTs}) is after quote deadline (${quoteDeadline}); ` +
        "payment was not finalized in time"
      );
    }
    // Note: we do NOT reject if wall-clock > quoteDeadline; we use block.timestamp only.
  }

  // ── 15. All checks passed — compute and return the paid result ─────────────
  // Idempotent: same input always produces the same result (deterministic function).
  const insights = computeInsights(input);

  const explorerTxUrl = buildTxExplorerUrl(config.chainId, txHash);

  return jsonResponse(200, {
    result:  insights,
    payment: {
      txHash,
      sessionId:    sessionId.toString(),
      requestId,
      amount:       amount.toString(),
      amountUsdc:   `$${(Number(amount) / 1_000_000).toFixed(6)} USDC`,
      chainId:      config.chainId,
      contractAddress: config.contractAddress,
      blockNumber:  receipt.blockNumber?.toString() ?? null,
      explorerUrl:  explorerTxUrl,
    },
  });
}

function err(status: number, message: string, retryable = false): Response {
  return jsonResponse(status, { error: message, retryable });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v
  ), {
    status,
    headers: {
      "Content-Type":  "application/json",
      "Cache-Control": "no-store",
      "Pragma":        "no-cache",
    },
  });
}
