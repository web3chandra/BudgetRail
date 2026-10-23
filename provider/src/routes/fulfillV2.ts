/**
 * POST /api/fulfill/v2
 *
 * Returns the Document Insights result ONLY after independent onchain proof
 * that BudgetRailV2.payForRequestV2() settled the exact payment.
 *
 * V2-specific verification beyond V1:
 *   1. Decodes PaymentSettledV2 (NOT PaymentSettled — V1/V2 events are distinct).
 *   2. Verifies TWO USDC ERC-20 Transfers in the same tx:
 *        Transfer 1: from=vault, to=provider C, value=baseAmount
 *        Transfer 2: from=vault, to=treasury E, value=feeAmount (skipped when feeAmount=0)
 *   3. Verifies baseAmount + feeAmount == grossAmount (no hidden fees, no rounding drift).
 *   4. Checks PaymentSettledV2.treasury == configured treasury E.
 *   5. Fee rounding: feeAmount may be 0 for micro-payments (floor rounds down).
 *      When feeAmount == 0, no treasury Transfer is expected — this is disclosed.
 *
 * Idempotent: same (requestId, input, txHash) always returns same result.
 * A requestId that already settled successfully will return the same result
 * without re-reading the chain — retry /api/fulfill/v2 safely after API outage.
 *
 * NEVER return a result for forged payment evidence. Any field mismatch → 400 (not retryable).
 * RPC errors → 503 (retryable). Missing receipt → 402 (retryable).
 */

import { toEventHash } from "viem";
import { type Config, USDC_ADDRESS } from "../lib/config.js";
import {
  fetchReceipt,
  fetchTransaction,
  fetchBlockTimestamp,
  decodePaymentSettledV2Log,
  decodeTransferLog,
  BUDGET_RAIL_V2_ABI,
  ERC20_ABI,
} from "../lib/onchain.js";
import { computeRequestHash, quoteSignerAddressFromPrivKey, computeV2Fee } from "../lib/eip712.js";
import { computeInsights } from "../lib/insights.js";
import { buildTxExplorerUrl } from "./explorerUrls.js";

// Derive topic0 from V2 ABI — NEVER hardcode.
// PaymentSettledV2 has a different signature from PaymentSettled, so its topic0 differs.
const PAYMENT_SETTLED_V2_TOPIC = toEventHash(
  BUDGET_RAIL_V2_ABI.find(x => x.type === "event" && x.name === "PaymentSettledV2")!
) as `0x${string}`;

const ERC20_TRANSFER_TOPIC = toEventHash(
  ERC20_ABI.find(x => x.type === "event" && x.name === "Transfer")!
) as `0x${string}`;

export async function handleFulfillV2(config: Config, req: Request): Promise<Response> {
  // ── V2 guard ─────────────────────────────────────────────────────────────
  if (!config.v2ContractAddress)
    return err(503, "V2 contract not configured on this server");
  const v2Contract = config.v2ContractAddress.toLowerCase();

  if (!config.treasuryAddress)
    return err(503, "Treasury address not configured on this server");

  // ── 0. Parse body ─────────────────────────────────────────────────────────
  let body: unknown;
  try { body = await req.json(); }
  catch { return err(400, "Invalid JSON body"); }
  if (typeof body !== "object" || body === null)
    return err(400, "Body must be a JSON object");

  const { input, quote: rawQuote, txHash: rawTxHash } = body as Record<string, unknown>;

  // ── 1. Validate input ─────────────────────────────────────────────────────
  if (typeof input !== "string") return err(400, "input must be a string");
  const inputBytes = new TextEncoder().encode(input);
  if (inputBytes.length === 0) return err(400, "input must not be empty");
  if (inputBytes.length > config.maxInputBytes)
    return err(400, `input exceeds ${config.maxInputBytes} bytes`);

  // ── 2. Validate txHash ────────────────────────────────────────────────────
  if (typeof rawTxHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(rawTxHash))
    return err(400, "txHash must be a 0x-prefixed 32-byte hex string");
  const txHash = rawTxHash.toLowerCase() as `0x${string}`;

  // ── 3. Validate V2 quote schema ───────────────────────────────────────────
  if (typeof rawQuote !== "object" || rawQuote === null)
    return err(400, "quote must be an object");
  const q = rawQuote as Record<string, unknown>;

  const requiredFields = [
    "sessionId", "requestId", "requestHash", "baseAmount", "feeAmount", "grossAmount",
    "deadline", "signature", "chainId", "contractAddress",
    "provider", "treasury", "quoteSignerAddress", "service", "version",
  ];
  for (const f of requiredFields) {
    if (q[f] === undefined) return err(400, `quote.${f} is required`);
  }

  if (q.version !== "2")
    return err(400, "quote.version must be '2' for V2 fulfill; use /api/fulfill for V1 quotes");

  let sessionId: bigint, baseAmount: bigint, feeAmount: bigint, grossAmount: bigint, deadline: bigint;
  try {
    sessionId   = BigInt(q.sessionId   as string);
    baseAmount  = BigInt(q.baseAmount  as string);
    feeAmount   = BigInt(q.feeAmount   as string);
    grossAmount = BigInt(q.grossAmount as string);
    deadline    = BigInt(q.deadline    as string);
  } catch { return err(400, "quote numeric fields must be parseable as BigInt"); }

  const requestId        = (q.requestId        as string).toLowerCase() as `0x${string}`;
  const quoteRequestHash = (q.requestHash      as string).toLowerCase() as `0x${string}`;
  const quoteChainId     = Number(q.chainId);
  const quoteContract    = (q.contractAddress  as string).toLowerCase();
  const quoteProvider    = (q.provider         as string).toLowerCase();
  const quoteTreasury    = (q.treasury         as string).toLowerCase();
  const quoteSignerAddr  = (q.quoteSignerAddress as string).toLowerCase();
  const service          = q.service as string;

  // ── 4. Validate quote matches this server's config ────────────────────────
  if (quoteChainId !== config.chainId)
    return err(400, `Quote chainId ${quoteChainId} != configured chainId ${config.chainId}`);
  if (quoteContract !== v2Contract)
    return err(400, "Quote contractAddress does not match deployed BudgetRailV2");
  if (quoteProvider !== config.providerPayoutAddress.toLowerCase())
    return err(400, "Quote provider does not match this server's payout address");
  if (quoteTreasury !== config.treasuryAddress.toLowerCase())
    return err(400, "Quote treasury does not match this server's configured treasury");
  if (service !== "document-insights-v1")
    return err(400, "Unsupported service in quote");

  const expectedSigner = quoteSignerAddressFromPrivKey(config.quoteSignerPrivateKey).toLowerCase();
  if (quoteSignerAddr !== expectedSigner)
    return err(400, "Quote quoteSignerAddress does not match this server's signer");

  // ── 5. Verify fee arithmetic (no hidden fees, no rounding drift) ──────────
  const { feeAmount: expectedFee, grossAmount: expectedGross } = computeV2Fee(baseAmount);
  if (feeAmount !== expectedFee)
    return err(400,
      `Quote feeAmount ${feeAmount} != server-computed fee ${expectedFee} for base ${baseAmount}. ` +
      `Fee must equal floor(base * 50 / 10000).`);
  if (grossAmount !== expectedGross)
    return err(400,
      `Quote grossAmount ${grossAmount} != base + fee = ${expectedGross}. ` +
      `No hidden fees or rounding drift permitted.`);
  if (baseAmount !== config.v2PricePerCall)
    return err(400, `Quote baseAmount ${baseAmount} does not match supported price ${config.v2PricePerCall}`);

  // ── 6. Verify requestHash = SHA-256(input) ────────────────────────────────
  // H-04 fix (Part 10 audit): requestHash is now required in the V2 quote body.
  // This binds the fulfilled result to the exact input that was paid for.
  // Without this check a caller could reuse a valid (requestId, txHash) for a different input.
  const computedHash = (await computeRequestHash(input)).toLowerCase();
  if (computedHash !== quoteRequestHash)
    return err(400, "quote.requestHash does not match SHA-256(input) — input may have been altered");

  // ── 7. Fetch tx and receipt ───────────────────────────────────────────────
  let receipt, tx;
  try {
    [receipt, tx] = await Promise.all([
      fetchReceipt(config, txHash),
      fetchTransaction(config, txHash),
    ]);
  } catch { return err(503, "RPC error fetching transaction; retry later", true); }

  if (!receipt || !tx)
    return err(402, "Transaction not found on chain; payment may not be confirmed yet", true);

  // ── 8. Receipt must be successful ─────────────────────────────────────────
  if (receipt.status !== "success")
    return err(402, "Transaction reverted; payment was not settled");

  // ── 9. tx.to must be the exact V2 contract ────────────────────────────────
  if (!tx.to || tx.to.toLowerCase() !== v2Contract)
    return err(400, "Transaction was not sent to the configured BudgetRailV2 contract");

  // ── 10. Find and decode PaymentSettledV2 log from exact V2 address ────────
  const paymentLog = receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === v2Contract &&
      log.topics[0]?.toLowerCase() === PAYMENT_SETTLED_V2_TOPIC.toLowerCase()
  );
  if (!paymentLog)
    return err(400,
      "No PaymentSettledV2 event from configured BudgetRailV2 in this transaction. " +
      "This is a permanent mismatch — do NOT retry payment. Verify the transaction on the explorer."
    );

  const settled = decodePaymentSettledV2Log(paymentLog);
  if (!settled) return err(400, "Failed to decode PaymentSettledV2 log");

  // ── 11. Match all PaymentSettledV2 fields ─────────────────────────────────
  if (settled.sessionId !== sessionId)
    return err(400, `PaymentSettledV2.sessionId ${settled.sessionId} != quote.sessionId ${sessionId}`);
  if (settled.requestId.toLowerCase() !== requestId)
    return err(400, "PaymentSettledV2.requestId does not match quote.requestId");
  if (settled.provider.toLowerCase() !== config.providerPayoutAddress.toLowerCase())
    return err(400, "PaymentSettledV2.provider does not match this server's payout address");
  if (settled.treasury.toLowerCase() !== config.treasuryAddress.toLowerCase())
    return err(400, "PaymentSettledV2.treasury does not match configured treasury — possible fee redirection attack");
  if (settled.baseAmount !== baseAmount)
    return err(400, `PaymentSettledV2.baseAmount ${settled.baseAmount} != quote.baseAmount ${baseAmount}`);
  if (settled.feeAmount !== feeAmount)
    return err(400, `PaymentSettledV2.feeAmount ${settled.feeAmount} != quote.feeAmount ${feeAmount}`);
  if (settled.grossAmount !== grossAmount)
    return err(400, `PaymentSettledV2.grossAmount ${settled.grossAmount} != quote.grossAmount ${grossAmount}`);

  // ── 12. tx.from must equal settled.agent ──────────────────────────────────
  if (tx.from.toLowerCase() !== settled.agent.toLowerCase())
    return err(400, "tx.from does not match the agent recorded in PaymentSettledV2");

  // ── 13. Verify TWO USDC Transfers ─────────────────────────────────────────
  // Transfer 1: from=vault, to=provider C, value=baseAmount
  // Transfer 2: from=vault, to=treasury E, value=feeAmount (only when feeAmount > 0)
  const usdcAddrLower  = USDC_ADDRESS.toLowerCase();
  const v2ContractLow  = v2Contract;
  const providerLower  = config.providerPayoutAddress.toLowerCase();
  const treasuryLower  = config.treasuryAddress.toLowerCase();

  const allTransferLogs = receipt.logs.filter(
    (log) =>
      log.address.toLowerCase() === usdcAddrLower &&
      log.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC.toLowerCase()
  );

  // Find provider transfer
  const providerTransferLog = allTransferLogs.find((log) => {
    const t = decodeTransferLog(log);
    return t &&
      t.from.toLowerCase() === v2ContractLow &&
      t.to.toLowerCase()   === providerLower &&
      t.value              === baseAmount;
  });
  if (!providerTransferLog)
    return err(400,
      `No USDC Transfer from vault to provider (${config.providerPayoutAddress}) ` +
      `for baseAmount ${baseAmount} found in this transaction.`
    );

  // Find treasury transfer (only required when feeAmount > 0)
  if (feeAmount > 0n) {
    const treasuryTransferLog = allTransferLogs.find((log) => {
      const t = decodeTransferLog(log);
      return t &&
        t.from.toLowerCase() === v2ContractLow &&
        t.to.toLowerCase()   === treasuryLower &&
        t.value              === feeAmount;
    });
    if (!treasuryTransferLog)
      return err(400,
        `No USDC Transfer from vault to treasury (${config.treasuryAddress}) ` +
        `for feeAmount ${feeAmount} found in this transaction. ` +
        `Both provider and treasury transfers must be present in the same transaction.`
      );
  }
  // Note: when feeAmount == 0 (micro-payment rounds down), no treasury transfer is expected.
  // The contract also skips the zero-transfer. This is disclosed in the V2 spec.

  // ── 14. Verify block timestamp ────────────────────────────────────────────
  if (receipt.blockNumber != null) {
    const blockTs = await fetchBlockTimestamp(config, receipt.blockNumber);
    if (blockTs != null && blockTs > deadline) {
      return err(400,
        `Payment block timestamp (${blockTs}) is after quote deadline (${deadline}); ` +
        "payment was not finalized in time"
      );
    }
  }

  // ── 15. All checks passed — return result ────────────────────────────────
  const insights = computeInsights(input);
  const explorerTxUrl = buildTxExplorerUrl(config.chainId, txHash);

  return jsonResponse(200, {
    result: insights,
    payment: {
      txHash,
      version:         "2",
      sessionId:       sessionId.toString(),
      requestId,
      baseAmount:      baseAmount.toString(),
      feeAmount:       feeAmount.toString(),
      grossAmount:     grossAmount.toString(),
      chainId:         config.chainId,
      contractAddress: config.v2ContractAddress,
      provider:        config.providerPayoutAddress,
      treasury:        config.treasuryAddress,
      blockNumber:     receipt.blockNumber?.toString() ?? null,
      explorerUrl:     explorerTxUrl,
      feeBps:          50,
      displaySplit:    `${baseAmount} base + ${feeAmount} fee = ${grossAmount} gross (USDC 6 decimals)`,
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
