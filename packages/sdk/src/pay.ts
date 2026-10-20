/**
 * BudgetRail SDK — Payment and fund management.
 *
 * All write operations require a BudgetRailSigner provided by the caller.
 * The SDK never stores, generates, or touches private keys.
 */

import { createPublicClient, http, decodeEventLog, type Log } from "viem";
import { BUDGET_RAIL_ABI, ERC20_ABI, USDC_ADDRESS } from "./abi.js";
import { BudgetRailError } from "./types.js";
import { decodePaymentSettledLog } from "./read.js";
import type {
  BudgetRailConfig,
  BudgetRailSigner,
  SignedQuote,
  PaymentResult,
  AddFundsResult,
  CloseAndRefundResult,
} from "./types.js";

function makeClient(config: Pick<BudgetRailConfig, "rpcUrl">) {
  return createPublicClient({ transport: http(config.rpcUrl, { timeout: 15_000 }) });
}

// ── simulatePay ────────────────────────────────────────────────────────────

/**
 * Simulate payForRequest to check for revert before opening the wallet.
 * Returns void on success; throws BudgetRailError with the revert reason on failure.
 * Pass the agent address as `from`.
 */
export async function simulatePay(
  config: BudgetRailConfig,
  agentAddress: `0x${string}`,
  sessionId: bigint,
  quote: SignedQuote,
): Promise<void> {
  const client = makeClient(config);
  try {
    await client.simulateContract({
      address:      config.contractAddress,
      abi:          BUDGET_RAIL_ABI,
      functionName: "payForRequest",
      args: [
        sessionId,
        quote.requestId,
        quote.requestHash,
        quote.amount,
        quote.quoteDeadline,
        quote.signature,
      ],
      account: agentAddress,
    });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    const code = classifyRevert(msg);
    throw new BudgetRailError(code, `Simulation failed: ${msg}`, false, err);
  }
}

// ── submitPayment ──────────────────────────────────────────────────────────

/**
 * Execute payForRequest via the provided signer.
 * Simulation should be called first via simulatePay.
 * Never retries the payment — idempotency is enforced onchain via requestId.
 */
export async function submitPayment(
  config: BudgetRailConfig,
  signer: BudgetRailSigner,
  sessionId: bigint,
  quote: SignedQuote,
): Promise<PaymentResult> {
  let txHash: `0x${string}`;
  try {
    txHash = await signer.writeContract({
      address:      config.contractAddress,
      abi:          BUDGET_RAIL_ABI,
      functionName: "payForRequest",
      args: [
        sessionId,
        quote.requestId,
        quote.requestHash,
        quote.amount,
        quote.quoteDeadline,
        quote.signature,
      ],
      chainId: config.chainId,
    });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (isUserRejection(msg)) {
      throw new BudgetRailError("UNKNOWN", "User rejected the transaction", false, err);
    }
    throw new BudgetRailError("UNKNOWN", `Transaction submission failed: ${msg}`, false, err);
  }

  const receipt = await signer.waitForReceipt(txHash);

  if (receipt.status !== "success") {
    throw new BudgetRailError("PAYMENT_NOT_SETTLED", `Transaction ${txHash} reverted`, false);
  }

  // Find PaymentSettled log from the contract
  const settledEvent = receipt.logs
    .filter((l) => l.address.toLowerCase() === config.contractAddress.toLowerCase())
    .map((l) => decodePaymentSettledLog(l as unknown as Log))
    .find((d) => d !== null && d.requestId.toLowerCase() === quote.requestId.toLowerCase());

  if (!settledEvent) {
    throw new BudgetRailError("PAYMENT_NOT_SETTLED", `PaymentSettled event not found in tx ${txHash}`, false);
  }

  return { txHash, receipt, settledEvent };
}

// ── waitForPayment ─────────────────────────────────────────────────────────

/**
 * Wait for a known txHash to confirm and return the payment result.
 * Use this to recover from a refresh after the transaction was broadcast.
 * Throws if the receipt is not found within a reasonable timeout.
 */
export async function waitForPayment(
  config: BudgetRailConfig,
  txHash: `0x${string}`,
  requestId: `0x${string}`,
): Promise<PaymentResult> {
  const client = makeClient(config);
  const MAX_POLLS = 30;
  for (let i = 0; i < MAX_POLLS; i++) {
    const raw = await client.getTransactionReceipt({ hash: txHash }).catch(() => null);
    if (raw) {
      if (raw.status !== "success") {
        throw new BudgetRailError("PAYMENT_NOT_SETTLED", `Transaction ${txHash} reverted`);
      }
      const settledEvent = raw.logs
        .filter((l: Log) => l.address.toLowerCase() === config.contractAddress.toLowerCase())
        .map((l: Log) => decodePaymentSettledLog(l))
        .find((d) => d !== null && d.requestId.toLowerCase() === requestId.toLowerCase());
      if (!settledEvent) {
        throw new BudgetRailError("PAYMENT_NOT_SETTLED", `PaymentSettled not found in ${txHash}`);
      }
      return {
        txHash,
        receipt: {
          status:          raw.status,
          transactionHash: raw.transactionHash,
          blockNumber:     raw.blockNumber,
          gasUsed:         raw.gasUsed,
          logs:            raw.logs as unknown as PaymentResult["receipt"]["logs"],
        },
        settledEvent,
      };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new BudgetRailError("PAYMENT_NOT_SETTLED", `Timed out waiting for receipt of ${txHash}`, true);
}

// ── retrieveResultByConfirmedPayment ──────────────────────────────────────

/**
 * Call /api/fulfill with a confirmed payment and return the provider result.
 * This is idempotent — the same txHash + requestId always returns the same result.
 * Never triggers a new onchain payment.
 */
export async function retrieveResultByConfirmedPayment(
  config: BudgetRailConfig,
  params: {
    txHash:    `0x${string}`;
    quote:     SignedQuote;
    inputText: string;
  },
): Promise<{ result: unknown; payment: Record<string, unknown> }> {
  const url = `${config.providerApiUrl}/api/fulfill`;
  let res: Response;
  try {
    res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        txHash: params.txHash,
        quote:  {
          ...params.quote,
          sessionId:     params.quote.sessionId.toString(),
          amount:        params.quote.amount.toString(),
          quoteDeadline: params.quote.quoteDeadline.toString(),
        },
        input: params.inputText,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new BudgetRailError("FULFILLMENT_FAILED", `Fulfill request failed: ${(err as Error).message}`, true, err);
  }

  const body = await res.json() as Record<string, unknown>;

  if (!res.ok) {
    const retryable = res.status === 402 || res.status >= 500;
    const msg = typeof body["error"] === "string" ? body["error"] : `HTTP ${res.status}`;
    throw new BudgetRailError("FULFILLMENT_FAILED", msg, retryable);
  }

  return {
    result:  body["result"],
    payment: (body["payment"] as Record<string, unknown>) ?? {},
  };
}

// ── addFunds ──────────────────────────────────────────────────────────────

/**
 * Owner-only: approve USDC + fund a session.
 * Skips the approval step when allowance is already sufficient.
 * Throws NOT_OWNER when signer.address != session.owner.
 */
export async function addFunds(
  config: BudgetRailConfig,
  ownerSigner: BudgetRailSigner,
  sessionId: bigint,
  amount: bigint,
): Promise<AddFundsResult> {
  const client = makeClient(config);

  // Read current allowance
  const allowance = (await client.readContract({
    address:      USDC_ADDRESS,
    abi:          ERC20_ABI,
    functionName: "allowance",
    args:         [ownerSigner.address, config.contractAddress],
  })) as bigint;

  let approveTxHash: `0x${string}` | null = null;

  if (allowance < amount) {
    const approveHash = await ownerSigner.writeContract({
      address:      USDC_ADDRESS,
      abi:          ERC20_ABI,
      functionName: "approve",
      args:         [config.contractAddress, amount],
      chainId:      config.chainId,
    });
    await ownerSigner.waitForReceipt(approveHash);
    approveTxHash = approveHash;
  }

  const fundHash = await ownerSigner.writeContract({
    address:      config.contractAddress,
    abi:          BUDGET_RAIL_ABI,
    functionName: "fundSession",
    args:         [sessionId, amount],
    chainId:      config.chainId,
  });
  await ownerSigner.waitForReceipt(fundHash);

  // Re-read session for updated totals
  const rawSession = await client.readContract({
    address:      config.contractAddress,
    abi:          BUDGET_RAIL_ABI,
    functionName: "getSession",
    args:         [sessionId],
  }) as { totalFunded: bigint; totalSpent: bigint };

  return {
    approveTxHash,
    fundTxHash:       fundHash,
    totalFundedAfter: rawSession.totalFunded,
    availableAfter:   rawSession.totalFunded - rawSession.totalSpent,
  };
}

// ── closeAndRefund ────────────────────────────────────────────────────────

/**
 * Owner-only: close a session and return the remaining balance.
 * After this call, the session is permanently closed.
 * Refund = totalFunded − totalSpent is returned to owner.
 */
export async function closeAndRefund(
  config: BudgetRailConfig,
  ownerSigner: BudgetRailSigner,
  sessionId: bigint,
): Promise<CloseAndRefundResult> {
  const client = makeClient(config);

  // Read session before closing to calculate expected refund
  const rawBefore = await client.readContract({
    address:      config.contractAddress,
    abi:          BUDGET_RAIL_ABI,
    functionName: "getSession",
    args:         [sessionId],
  }) as { totalFunded: bigint; totalSpent: bigint; closed: boolean; owner: `0x${string}` };

  if (rawBefore.closed) {
    throw new BudgetRailError("SESSION_CLOSED", `Session ${sessionId} is already closed`);
  }
  if (rawBefore.owner.toLowerCase() !== ownerSigner.address.toLowerCase()) {
    throw new BudgetRailError("NOT_OWNER", `Signer ${ownerSigner.address} is not the session owner`);
  }

  const txHash = await ownerSigner.writeContract({
    address:      config.contractAddress,
    abi:          BUDGET_RAIL_ABI,
    functionName: "closeSession",
    args:         [sessionId],
    chainId:      config.chainId,
  });
  await ownerSigner.waitForReceipt(txHash);

  const refunded   = rawBefore.totalFunded > rawBefore.totalSpent
    ? rawBefore.totalFunded - rawBefore.totalSpent
    : 0n;

  return { txHash, refunded, totalSpent: rawBefore.totalSpent };
}

// ── Internal helpers ───────────────────────────────────────────────────────

function isUserRejection(msg: string): boolean {
  return /user (rejected|denied)|action_rejected|4001/i.test(msg);
}

function classifyRevert(msg: string): BudgetRailError["code"] {
  if (/NotAgent/i.test(msg))             return "NOT_AGENT";
  if (/NotOwner/i.test(msg))             return "NOT_OWNER";
  if (/SessionAlreadyClosed/i.test(msg)) return "SESSION_CLOSED";
  if (/SessionExpired/i.test(msg))       return "SESSION_EXPIRED";
  if (/RequestAlreadyPaid/i.test(msg))   return "DUPLICATE_REQUEST";
  if (/InvalidSignature/i.test(msg))     return "INVALID_SIGNATURE";
  if (/QuoteExpired/i.test(msg))         return "QUOTE_EXPIRED";
  if (/PerPaymentCap/i.test(msg))        return "PER_PAYMENT_CAP_EXCEEDED";
  if (/BudgetExceeded|LifetimeBudget/i.test(msg)) return "BUDGET_EXCEEDED";
  if (/ZeroAddress/i.test(msg))          return "ZERO_ADDRESS";
  return "SIMULATION_FAILED";
}

// Re-export decodeEventLog helper for external use
export { decodeEventLog };
