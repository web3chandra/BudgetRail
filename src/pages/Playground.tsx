/**
 * Page 3 — API Playground (/playground)
 *
 * Complete rewrite with a proper state machine — all state transitions happen
 * in useEffect, never in the render body.
 *
 * Flow:
 *   idle → fetching_quote → quote_ready → paying → confirming_tx → fulfilling → done
 *                                                                              → fulfill_error (retryable)
 *                                       → pay_error
 *
 * Key guarantees:
 *   - No render-body side effects; all transitions via useEffect.
 *   - Provider returns { result, payment }; we read result (not insights).
 *   - A confirmed payment is NEVER retried. Only /api/fulfill is retried.
 *   - simulateContract runs before wallet opens.
 *   - Role indicator: owner vs agent clearly separated.
 *   - Sample document button for quick demo.
 *   - Schema-validated API responses.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
  usePublicClient,
  useSwitchChain,
} from "wagmi";
import { decodeEventLog } from "viem";
import { arcTestnet } from "viem/chains";
import { Info, AlertTriangle, Copy, CheckCircle2, ChevronDown, ChevronUp, RotateCcw } from "lucide-react";

import { BUDGET_RAIL_ABI, BUDGET_RAIL_ADDRESS, PROVIDER_API_URL, PROVIDER_CONFIGURED, providerConfigError } from "@/lib/budgetRail";
import { VersionBanner } from "@/components/VersionBanner";
import { formatUsdcShort, formatAddr, formatTs, sessionStatus } from "@/lib/format";
import { parseOnchainError } from "@/lib/parseOnchainError";
import { NetworkGuard } from "@/components/NetworkGuard";
import { TransactionStepper, type Step } from "@/components/TransactionStepper";
import { TxLink } from "@/components/ExplorerLink";
import { ErrorBanner, ConfirmModal, StatusBadge } from "@/components/shared";
import { toast } from "sonner";

const CHAIN_ID     = arcTestnet.id;
const MAX_INPUT_BYTES = 8192;
// localStorage key version — bump to invalidate stale recovery state
const RECOVERY_KEY_VERSION = "v1";

const SAMPLE_DOCUMENT = `BudgetRail is a session-based USDC payment rail deployed on Arc Testnet.
It allows a software agent to purchase digital services using a bounded USDC budget
authorized by a wallet owner. The owner creates a session with a maximum budget,
per-call cap, expiry date, and an authorized agent wallet. The agent requests a
signed quote from a provider API, then submits the payment through the smart contract.
The contract verifies the EIP-712 signature, checks the agent authorization and budget
limits, and transfers the exact quoted amount to the provider. The provider independently
verifies the onchain payment receipt before delivering the result. The owner can close
the session at any time and recover all unspent funds.`;

// ── Types ──────────────────────────────────────────────────────────────────

/** Persisted to localStorage after payment confirmation, cleared on success or explicit dismiss. */
interface RecoveryState {
  version:         string;
  chainId:         number;
  contractAddress: string;
  sessionId:       string;
  requestId:       string;
  txHash:          `0x${string}`;
  quote:           SignedQuote;
  /** Input text is stored for fulfillment retry. User can clear it if sensitive. */
  inputText:       string;
  savedAt:         number; // unix ms
}

function recoveryKey(chainId: number, contractAddress: string, sessionId: string, requestId: string): string {
  return `budgetrail_pg_recovery_${RECOVERY_KEY_VERSION}_${chainId}_${contractAddress.toLowerCase()}_${sessionId}_${requestId.slice(0, 18)}`;
}

function saveRecovery(state: RecoveryState): void {
  try {
    const key = recoveryKey(state.chainId, state.contractAddress, state.sessionId, state.requestId);
    localStorage.setItem(key, JSON.stringify(state));
  } catch { /* storage full or unavailable */ }
}

function clearRecovery(chainId: number, contractAddress: string, sessionId: string, requestId: string): void {
  try {
    const key = recoveryKey(chainId, contractAddress, sessionId, requestId);
    localStorage.removeItem(key);
  } catch { /* ignore */ }
}

interface SignedQuote {
  sessionId:          string;
  requestId:          string;
  requestHash:        string;
  amount:             string;      // V1: gross; V2: gross (= base + fee)
  quoteDeadline:      string;
  signature:          `0x${string}`;
  chainId:            number;
  contractAddress:    `0x${string}`;
  providerPayout:     `0x${string}`;
  quoteSignerAddress: `0x${string}`;
  service:            string;
  displayPrice:       string;
  // V2-only fields (absent on V1 quotes)
  version?:           string;      // "2" for V2 quotes
  baseAmount?:        string;      // provider C receives
  feeAmount?:         string;      // treasury E receives
  grossAmount?:       string;      // session debited
  treasury?:          `0x${string}`; // treasury E address from signed data
}

interface DocumentResult {
  wordCount:           number;
  sentenceCount:       number;
  paragraphCount:      number;
  characterCount:      number;
  avgWordsPerSentence: number;
  readabilityTier:     string;
  extractiveSummary:   string[];
  top10Keywords:       Array<{ word: string; count: number }>;
}

interface PaymentReceipt {
  txHash:          string;
  sessionId:       string;
  requestId:       string;
  amount:          string;
  amountUsdc:      string;
  chainId:         number;
  contractAddress: string;
  blockNumber:     string | null;
  explorerUrl:     string;
}

// Validate that a quote response has all required fields
function validateQuote(d: unknown): d is SignedQuote {
  if (typeof d !== "object" || d === null) return false;
  const q = d as Record<string, unknown>;
  return (
    typeof q.sessionId === "string" &&
    typeof q.requestId === "string" &&
    typeof q.requestHash === "string" &&
    typeof q.amount === "string" &&
    typeof q.quoteDeadline === "string" &&
    typeof q.signature === "string" &&
    typeof q.chainId === "number" &&
    typeof q.contractAddress === "string" &&
    typeof q.providerPayout === "string" &&
    typeof q.quoteSignerAddress === "string" &&
    typeof q.service === "string"
  );
}

// ── Structured error classifier ────────────────────────────────────────────

interface ClassifiedError {
  code: string;
  userMessage: string;
  retryable: boolean;
  action: string;
}

function classifyError(raw: string, context: "quote" | "pay" | "fulfill"): ClassifiedError {
  const msg = raw.toLowerCase();
  if (context === "quote") {
    if (msg.includes("session not found") || msg.includes("notfound"))
      return { code: "SESSION_NOT_FOUND", userMessage: "Session not found on this contract/chain.", retryable: false, action: "Check the session ID and ensure you are on the correct network." };
    if (msg.includes("session closed") || msg.includes("closed"))
      return { code: "SESSION_CLOSED", userMessage: "This session is closed and can no longer accept payments.", retryable: false, action: "Create a new session." };
    if (msg.includes("session expired") || msg.includes("expired"))
      return { code: "SESSION_EXPIRED", userMessage: "This session has expired.", retryable: false, action: "Create a new session or top up an active one." };
    if (msg.includes("provider") || msg.includes("503") || msg.includes("network") || msg.includes("fetch"))
      return { code: "PROVIDER_UNREACHABLE", userMessage: "Provider API is unreachable.", retryable: true, action: "Check that the provider server is running, then retry." };
    if (msg.includes("schema") || msg.includes("unexpected"))
      return { code: "PROVIDER_SCHEMA_MISMATCH", userMessage: "Provider returned an unexpected response format.", retryable: false, action: "Check provider version compatibility." };
  }
  if (context === "pay") {
    if (msg.includes("wrong network") || msg.includes("chain"))
      return { code: "WRONG_NETWORK", userMessage: "Wrong network.", retryable: true, action: "Switch your wallet to Arc Testnet (chain 5042002)." };
    if (msg.includes("notagent") || msg.includes("not agent") || msg.includes("unauthorized"))
      return { code: "WRONG_AGENT", userMessage: "Connected wallet is not the authorized agent for this session.", retryable: false, action: "Switch to the agent wallet shown in the session details." };
    if (msg.includes("quotesigner") || msg.includes("quote signer") || msg.includes("badsig") || msg.includes("bad sig") || msg.includes("signature"))
      return { code: "SIGNER_MISMATCH", userMessage: "Quote signature verification failed.", retryable: false, action: "The provider's quote signer may have rotated. Request a new quote." };
    if (msg.includes("deadline") || msg.includes("expired") || msg.includes("quoteexpired"))
      return { code: "QUOTE_EXPIRED", userMessage: "Quote has expired.", retryable: true, action: "Request a new quote — no payment was taken." };
    if (msg.includes("insufficient") || msg.includes("balance") || msg.includes("budget"))
      return { code: "INSUFFICIENT_BALANCE", userMessage: "Insufficient session balance for this payment.", retryable: false, action: "Add funds to the session (owner only), then retry." };
    if (msg.includes("gas") || msg.includes("intrinsic"))
      return { code: "INSUFFICIENT_GAS", userMessage: "Transaction failed — insufficient gas.", retryable: true, action: "On Arc Testnet, USDC is gas. Ensure the agent wallet has USDC for gas." };
    if (msg.includes("simulation failed"))
      return { code: "SIM_FAILED", userMessage: "Transaction simulation failed — no gas spent.", retryable: false, action: raw.replace("Simulation failed: ", "") };
    if (msg.includes("user rejected") || msg.includes("cancelled") || msg.includes("denied"))
      return { code: "WALLET_REJECTED", userMessage: "Transaction was rejected in your wallet.", retryable: true, action: "Click Pay again when ready." };
    if (msg.includes("reverted") || msg.includes("receipt"))
      return { code: "TX_REVERTED", userMessage: "Transaction reverted onchain.", retryable: false, action: "Check session balance and quote validity, then request a fresh quote." };
  }
  if (context === "fulfill") {
    if (msg.includes("tx not found") || msg.includes("402"))
      return { code: "INDEXING_DELAY", userMessage: "Provider has not indexed your payment yet.", retryable: true, action: "Wait a few seconds and click Retry — no new payment needed." };
    if (msg.includes("503") || msg.includes("network") || msg.includes("fetch"))
      return { code: "PROVIDER_UNREACHABLE", userMessage: "Provider API is temporarily unreachable.", retryable: true, action: "Retry when the provider is back online — your payment is already confirmed." };
    if (msg.includes("permanent") || msg.includes("400"))
      return { code: "FULFILL_PERMANENT", userMessage: "Provider rejected the fulfillment request.", retryable: false, action: "Do NOT pay again. Contact the provider with your transaction hash." };
  }
  return { code: "UNKNOWN", userMessage: raw, retryable: context !== "pay", action: "" };
}

// Validate that a fulfill response has result + payment
function validateFulfillResponse(d: unknown): d is { result: DocumentResult; payment: PaymentReceipt } {
  if (typeof d !== "object" || d === null) return false;
  const r = d as Record<string, unknown>;
  return typeof r.result === "object" && r.result !== null &&
         typeof r.payment === "object" && r.payment !== null;
}

type Stage =
  | "idle"
  | "fetching_quote"
  | "quote_ready"
  | "paying"
  | "confirming_tx"
  | "fulfilling"
  | "fulfill_error"    // retryable — payment already confirmed, only /api/fulfill failed
  | "pay_error"        // non-retryable payment failure
  | "done";

interface FlowData {
  stage:      Stage;
  quote?:     SignedQuote;
  hash?:      `0x${string}`;
  result?:    DocumentResult;
  payment?:   PaymentReceipt;
  error?:     string;
  errorCode?: string;
  errorAction?: string;
}

// ── Small helpers ──────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="ml-1 inline-flex items-center text-[var(--subtle)] hover:text-[var(--ink)] transition-colors"
      title="Copy address"
    >
      {copied ? <CheckCircle2 size={12} className="text-[var(--success)]" /> : <Copy size={12} />}
    </button>
  );
}

// ── Component ──────────────────────────────────────────────────────────────

export function Playground() {
  const { address, isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });

  const [sessionIdInput, setSessionIdInput] = useState("");
  const [inputText, setInputText]           = useState("");
  const [flow, setFlow]                     = useState<FlowData>({ stage: "idle" });
  const [showConfirm, setShowConfirm]       = useState(false);
  const [showRoles, setShowRoles]           = useState(false);
  const [recoveryBanner, setRecoveryBanner] = useState<RecoveryState | null>(null);

  // Prevent double-submit
  const payInFlight = useRef(false);

  const sessionIdBigint = (() => {
    try { return sessionIdInput ? BigInt(sessionIdInput) : null; } catch { return null; }
  })();

  // Read session details
  const { data: sessionData, isLoading: sessionLoading } = useReadContract({
    address: BUDGET_RAIL_ADDRESS,
    abi:     BUDGET_RAIL_ABI,
    functionName: "getSession",
    args:    [sessionIdBigint ?? 0n],
    chainId: CHAIN_ID,
    query:   { enabled: !!sessionIdBigint && sessionIdBigint > 0n, refetchInterval: 15_000 },
  });
  const session = sessionData;

  const isAgentWallet = !!(session && address &&
    session.agent.toLowerCase() === address.toLowerCase());
  const isOwnerWallet = !!(session && address &&
    session.owner.toLowerCase() === address.toLowerCase());

  const inputBytes    = new TextEncoder().encode(inputText).length;
  const inputTooLarge = inputBytes > MAX_INPUT_BYTES;

  // ── wagmi write + receipt ─────────────────────────────────────────────

  const {
    writeContract,
    data:      payHashRaw,
    isPending: isWalletPending,
    isError:   isWalletError,
    error:     walletError,
    reset:     resetWrite,
  } = useWriteContract();

  const {
    isSuccess: isReceiptSuccess,
    isError:   isReceiptError,
    error:     receiptError,
    data:      receipt,
  } = useWaitForTransactionReceipt({ hash: payHashRaw });

  // ── State machine effects ─────────────────────────────────────────────

  // Wallet rejection / error
  useEffect(() => {
    if (!isWalletError || flow.stage !== "paying") return;
    payInFlight.current = false;
    const raw = parseOnchainError(walletError);
    const classified = classifyError(raw, "pay");
    setFlow({ stage: "pay_error", quote: flow.quote, error: classified.userMessage, errorCode: classified.code, errorAction: classified.action });
    resetWrite();
  }, [isWalletError, walletError, flow.stage, flow.quote, resetWrite]);

  // Hash available → move to confirming_tx
  useEffect(() => {
    if (!payHashRaw || flow.stage !== "paying") return;
    setFlow(f => ({ ...f, stage: "confirming_tx", hash: payHashRaw }));
  }, [payHashRaw, flow.stage]);

  // Receipt error
  useEffect(() => {
    if (!isReceiptError || flow.stage !== "confirming_tx") return;
    payInFlight.current = false;
    const raw = parseOnchainError(receiptError) + " (receipt)";
    const classified = classifyError(raw, "pay");
    setFlow(f => ({ ...f, stage: "pay_error", error: classified.userMessage, errorCode: classified.code, errorAction: classified.action }));
  }, [isReceiptError, receiptError, flow.stage]);

  // Receipt success → verify PaymentSettled → persist recovery → move to fulfilling
  useEffect(() => {
    if (!isReceiptSuccess || !receipt || flow.stage !== "confirming_tx") return;
    payInFlight.current = false;

    if ((receipt.status as string) === "reverted") {
      setFlow(f => ({ ...f, stage: "pay_error", error: "Transaction reverted onchain. Check session balance and try again." }));
      return;
    }

    let settled = false;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== BUDGET_RAIL_ADDRESS.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: BUDGET_RAIL_ABI, data: log.data, topics: log.topics });
        if (decoded.eventName === "PaymentSettled") { settled = true; break; }
      } catch { /* different event */ }
    }
    if (!settled) {
      setFlow(f => ({ ...f, stage: "pay_error", error: "PaymentSettled event not found in receipt. Unexpected contract state." }));
      return;
    }

    // Persist recovery state BEFORE calling fulfill so a refresh never loses the tx hash.
    // Use payHashRaw directly — flow.hash may not yet reflect the latest state flush.
    const confirmedHash = payHashRaw ?? flow.hash;
    if (confirmedHash && flow.quote) {
      const rec: RecoveryState = {
        version:         RECOVERY_KEY_VERSION,
        chainId:         CHAIN_ID,
        contractAddress: BUDGET_RAIL_ADDRESS,
        sessionId:       flow.quote.sessionId,
        requestId:       flow.quote.requestId,
        txHash:          confirmedHash,
        quote:           flow.quote,
        inputText,
        savedAt:         Date.now(),
      };
      saveRecovery(rec);
    }

    // Move to fulfilling — this triggers the fulfill useEffect below
    setFlow(f => ({ ...f, stage: "fulfilling" }));
  }, [isReceiptSuccess, receipt, flow.stage, flow.hash, flow.quote, inputText, payHashRaw]);

  // Auto-trigger fulfill when stage becomes "fulfilling".
  // fulfillInFlight prevents a double-call when handleRetryFulfill also sets stage→fulfilling.
  const fulfillInFlight = useRef(false);
  useEffect(() => {
    if (flow.stage !== "fulfilling" || !flow.quote || !(flow.hash ?? payHashRaw)) return;
    if (fulfillInFlight.current) return;
    fulfillInFlight.current = true;
    const hash = (flow.hash ?? payHashRaw)!;
    void runFulfill(flow.quote, hash, inputText).finally(() => {
      fulfillInFlight.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.stage]);

  // ── Actions ───────────────────────────────────────────────────────────

  async function handleRequestQuote() {
    if (!sessionIdBigint) { toast.error("Enter a valid session ID"); return; }
    if (!inputText.trim()) { toast.error("Enter document text"); return; }
    if (inputTooLarge)     { toast.error(`Input too large (max ${MAX_INPUT_BYTES} bytes)`); return; }
    if (!PROVIDER_CONFIGURED) { toast.error("Provider not configured"); return; }

    setFlow({ stage: "fetching_quote" });
    try {
      const resp = await fetch(`${PROVIDER_API_URL}/api/quotes`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          sessionId: sessionIdBigint.toString(),
          service:   "document-insights-v1",
          input:     inputText,
        }),
      });
      const data = await resp.json() as unknown;
      if (!resp.ok) {
        const msg = (data as Record<string, unknown>).error as string ?? `HTTP ${resp.status}`;
        throw new Error(msg);
      }
      if (!validateQuote(data)) {
        throw new Error("Provider returned an unexpected quote schema. Check provider version.");
      }
      setFlow({ stage: "quote_ready", quote: data });
    } catch (err) {
      const raw = `Quote failed: ${(err as Error).message}`;
      const classified = classifyError(raw, "quote");
      setFlow({ stage: "pay_error", error: classified.userMessage, errorCode: classified.code, errorAction: classified.action });
    }
  }

  function handlePay() {
    if (flow.stage !== "quote_ready" || !flow.quote) return;
    if (chainId !== CHAIN_ID) { switchChain({ chainId: CHAIN_ID }); return; }
    if (!isAgentWallet) { toast.error("Switch to agent wallet B to pay"); return; }
    setShowConfirm(true);
  }

  async function onConfirmPay() {
    setShowConfirm(false);
    if (flow.stage !== "quote_ready" || !flow.quote || !publicClient) return;
    if (payInFlight.current) return;

    const { quote } = flow;

    // Simulate before opening wallet
    setFlow({ stage: "paying", quote });
    try {
      await (publicClient.simulateContract as (opts: unknown) => Promise<unknown>)({
        address:      BUDGET_RAIL_ADDRESS,
        abi:          BUDGET_RAIL_ABI,
        functionName: "payForRequest",
        args: [
          BigInt(quote.sessionId),
          quote.requestId  as `0x${string}`,
          quote.requestHash as `0x${string}`,
          BigInt(quote.amount),
          BigInt(quote.quoteDeadline),
          quote.signature,
        ],
        account: address,
      });
    } catch (simErr) {
      const raw = `Simulation failed: ${parseOnchainError(simErr)}`;
      const classified = classifyError(raw, "pay");
      setFlow({ stage: "quote_ready", quote, error: classified.userMessage, errorCode: classified.code, errorAction: classified.action });
      return;
    }

    payInFlight.current = true;
    writeContract({
      address:      BUDGET_RAIL_ADDRESS,
      abi:          BUDGET_RAIL_ABI,
      functionName: "payForRequest",
      args: [
        BigInt(quote.sessionId),
        quote.requestId  as `0x${string}`,
        quote.requestHash as `0x${string}`,
        BigInt(quote.amount),
        BigInt(quote.quoteDeadline),
        quote.signature,
      ],
      chainId: CHAIN_ID,
    });
  }

  const runFulfill = useCallback(async (quote: SignedQuote, hash: `0x${string}`, inputForFulfill: string) => {
    try {
      const resp = await fetch(`${PROVIDER_API_URL}/api/fulfill`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ input: inputForFulfill, quote, txHash: hash }),
      });
      const data = await resp.json() as unknown;
      if (!resp.ok) {
        const msg = (data as Record<string, unknown>).error as string ?? `HTTP ${resp.status}`;
        const classified = classifyError(msg, "fulfill");
        setFlow(f => ({ ...f, stage: "fulfill_error",
          error: classified.userMessage, errorCode: classified.code, errorAction: classified.action,
          quote, hash }));
        return;
      }
      if (!validateFulfillResponse(data)) {
        setFlow(f => ({ ...f, stage: "fulfill_error",
          error: "Provider returned unexpected response shape.",
          errorCode: "PROVIDER_SCHEMA_MISMATCH",
          errorAction: "Retry is safe — your payment is already confirmed onchain.",
          quote, hash }));
        return;
      }
      // Success — clear recovery state
      clearRecovery(CHAIN_ID, BUDGET_RAIL_ADDRESS, quote.sessionId, quote.requestId);
      setRecoveryBanner(null);
      setFlow({ stage: "done", quote, hash, result: data.result, payment: data.payment });
      toast.success("Result received — payment verified onchain!");
    } catch (err) {
      const classified = classifyError((err as Error).message, "fulfill");
      setFlow(f => ({
        ...f,
        stage:       "fulfill_error",
        error:       classified.userMessage,
        errorCode:   classified.code,
        errorAction: classified.action || "Retry is safe — your payment is confirmed onchain.",
        quote,
        hash,
      }));
    }
  }, []);

  function handleRetryFulfill() {
    if (flow.stage !== "fulfill_error" || !flow.quote || !flow.hash) return;
    if (fulfillInFlight.current) return;
    // Reset ref so the useEffect gate doesn't block the retry
    fulfillInFlight.current = false;
    setFlow(f => ({ ...f, stage: "fulfilling" }));
    // The useEffect will pick this up and call runFulfill
  }

  function resetFlow() {
    payInFlight.current = false;
    resetWrite();
    setFlow({ stage: "idle" });
    setRecoveryBanner(null);
  }

  // Restore from recovery: load the stored state into the active flow for retry
  function handleRestoreRecovery(rec: RecoveryState) {
    setSessionIdInput(rec.sessionId);
    setInputText(rec.inputText);
    setRecoveryBanner(null);
    // Restore to fulfill_error so the "Retry result delivery" button is shown
    setFlow({
      stage: "fulfill_error",
      quote: rec.quote,
      hash:  rec.txHash,
      error: "Payment was confirmed onchain but result delivery did not complete. Click below to retry — no new payment needed.",
    });
    toast("Payment recovery loaded. Click 'Retry result delivery' to get your result.");
  }

  // On mount: check localStorage for any pending recovery state matching the current session
  useEffect(() => {
    if (!sessionIdBigint || !BUDGET_RAIL_ADDRESS) return;
    // We don't know the requestId yet at mount, so we scan recent entries
    // by checking all keys with our prefix in localStorage
    try {
      const prefix = `budgetrail_pg_recovery_${RECOVERY_KEY_VERSION}_${CHAIN_ID}_${BUDGET_RAIL_ADDRESS.toLowerCase()}_${sessionIdBigint.toString()}_`;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(prefix)) continue;
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as RecoveryState;
        if (parsed.version !== RECOVERY_KEY_VERSION) { localStorage.removeItem(key); continue; }
        // Show the recovery banner — do not auto-restore without user action
        setRecoveryBanner(parsed);
        break;
      }
    } catch { /* storage unavailable */ }
  // Only re-run when session ID changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionIdBigint?.toString()]);

  // ── Stepper ──────────────────────────────────────────────────────────

  // 4 explicit lifecycle stages as distinct stepper steps
  const steps: Step[] = [
    {
      id:     "quote",
      label:  "1. Quote issued by provider",
      status: flow.stage === "fetching_quote" ? "active"
            : (flow.stage === "idle" || (flow.stage === "pay_error" && !flow.quote)) ? "idle"
            : "success",
    },
    {
      id:     "broadcast",
      label:  "2. Payment broadcast to chain",
      status: flow.stage === "paying" ? "active"
            : (flow.stage === "confirming_tx" || flow.stage === "fulfilling" || flow.stage === "fulfill_error" || flow.stage === "done") ? "success"
            : (flow.stage === "pay_error" && !!flow.quote) ? "error"
            : "idle",
      detail: flow.hash,
    },
    {
      id:     "confirm",
      label:  "3. Payment confirmed onchain",
      status: flow.stage === "confirming_tx" ? "active"
            : (flow.stage === "fulfilling" || flow.stage === "fulfill_error" || flow.stage === "done") ? "success"
            : (flow.stage === "pay_error" && !!flow.hash) ? "error"
            : "idle",
      detail: flow.hash,
    },
    {
      id:     "fulfill",
      label:  "4. Provider verifies + delivers result",
      status: flow.stage === "fulfilling" ? "active"
            : flow.stage === "done" ? "success"
            : flow.stage === "fulfill_error" ? "error"
            : "idle",
    },
  ];

  // ── Role indicator ────────────────────────────────────────────────────

  const roleLabel = !isConnected ? null
    : !session          ? null
    : isAgentWallet     ? "agent"
    : isOwnerWallet     ? "owner"
    : "other";

  const roleBadge = roleLabel === "agent"
    ? <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(141,216,159,0.15)] border border-[rgba(141,216,159,0.3)] px-2 py-0.5 text-xs font-semibold text-[var(--success)]">Agent wallet B — can pay</span>
    : roleLabel === "owner"
    ? <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 text-xs font-semibold text-amber-300">Owner wallet A — read-only here</span>
    : roleLabel === "other"
    ? <span className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-strong)] border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--subtle)]">Not owner or agent</span>
    : null;

  const configErr = providerConfigError();

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="max-w-2xl space-y-6">
      {/* Header */}
      <div>
        <h1 className="display font-bold text-2xl text-[var(--ink)] tracking-tight">Pay for an API result</h1>
        <p className="text-sm text-[var(--subtle)] mt-1">
          Agent wallet B pays $0.05 USDC through BudgetRail for a real Document Insights result.
          Payment is verified onchain before any result is delivered.
        </p>
      </div>

      {/* Version + network banner */}
      <VersionBanner version="V1" className="mb-2" />

      {/* How it works */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
        <button
          onClick={() => setShowRoles(v => !v)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-[var(--ink-2)] hover:bg-[var(--surface-strong)] transition-colors"
        >
          <span>How does this work?</span>
          {showRoles ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        {showRoles && (
          <div className="px-4 pb-4 space-y-2 text-xs text-[var(--muted)] border-t border-[var(--border)] pt-3">
            <p><strong className="text-[var(--ink-2)]">Owner (wallet A)</strong> — Created this session and funded it with USDC. Can view results and close session. Cannot pay.</p>
            <p><strong className="text-[var(--ink-2)]">Agent (wallet B)</strong> — The address authorized at session creation. The ONLY wallet that can call payForRequest. This is enforced by the smart contract — no other wallet can pay, even if you have the session ID.</p>
            <p><strong className="text-[var(--ink-2)]">Provider (wallet C)</strong> — Receives USDC after a valid payment. Also runs this API server.</p>
            <p><strong className="text-[var(--ink-2)]">Quote signer (wallet D)</strong> — Signs each quote with an EIP-712 signature. The contract verifies this signature. A forged or expired quote will revert.</p>
            <p className="pt-1 text-[var(--subtle)]">The smart contract enforces: budget limits, agent identity, quote validity, replay protection, and direct USDC transfer to provider. The provider independently verifies the onchain receipt before returning any result.</p>
          </div>
        )}
      </div>

      {/* Provider status */}
      {configErr && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/8 px-4 py-3 flex items-start gap-3">
          <AlertTriangle size={15} className="shrink-0 text-amber-400 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-300">Provider unavailable</p>
            <p className="text-xs text-amber-200/70 mt-0.5">{configErr}</p>
          </div>
        </div>
      )}

      <NetworkGuard>
        {!isConnected ? (
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
            <p className="text-[var(--muted)]">Connect a wallet to request a quote or pay.</p>
          </div>
        ) : (
          <div className="space-y-5">
            {/* Role indicator */}
            {roleBadge && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-[var(--subtle)]">Connected as:</span>
                {roleBadge}
              </div>
            )}

            {/* Recovery banner — shown when a confirmed-but-unfulfilled payment is found in localStorage */}
            {recoveryBanner && flow.stage === "idle" && (
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/8 px-4 py-3 space-y-2">
                <div className="flex items-start gap-2">
                  <RotateCcw size={14} className="shrink-0 text-amber-400 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-amber-300">Payment confirmed — result not yet delivered</p>
                    <p className="text-xs text-amber-200/70 mt-0.5">
                      Tx <span className="mono">{recoveryBanner.txHash.slice(0, 20)}…</span> was
                      confirmed onchain for session #{recoveryBanner.sessionId} but the result was
                      not received. No new payment is needed.
                    </p>
                    <p className="text-xs text-amber-200/50 mt-0.5">
                      Saved {new Date(recoveryBanner.savedAt).toLocaleTimeString()}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleRestoreRecovery(recoveryBanner)}
                    className="flex-1 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-200
                               py-2 text-xs font-semibold hover:bg-amber-500/30 transition-colors"
                  >
                    Restore and retry result delivery
                  </button>
                  <button
                    onClick={() => {
                      clearRecovery(recoveryBanner.chainId, recoveryBanner.contractAddress,
                        recoveryBanner.sessionId, recoveryBanner.requestId);
                      setRecoveryBanner(null);
                    }}
                    className="rounded-lg bg-[var(--surface-strong)] border border-[var(--border)]
                               text-[var(--subtle)] px-3 py-2 text-xs hover:text-[var(--muted)] transition-colors"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            {/* Session ID + status */}
            <div>
              <label className="block text-sm font-medium text-[var(--ink-2)] mb-1.5" htmlFor="sessionId">
                Session ID
              </label>
              <input
                id="sessionId"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={sessionIdInput}
                onChange={e => { setSessionIdInput(e.target.value.replace(/[^0-9]/g, "")); setFlow({ stage: "idle" }); }}
                placeholder="e.g. 1"
                className="w-40 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]
                           px-3 py-2.5 text-sm tabular text-[var(--ink)] placeholder:text-[var(--subtle)]
                           focus:outline-none focus:ring-2 focus:ring-[var(--focus)]"
              />
              {sessionLoading && <p className="text-xs text-[var(--subtle)] mt-1">Loading…</p>}
              {session && sessionIdBigint !== null && sessionIdBigint > 0n && (
                <div className="mt-2 rounded-xl bg-[var(--surface-muted)] border border-[var(--border)] px-4 py-3 space-y-2 text-xs">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={sessionStatus(session.closed, session.expiresAt)} />
                    <span className="text-[var(--subtle)]">Expires: {formatTs(session.expiresAt)}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    <span className="text-[var(--subtle)]">Available</span>
                    <span className="font-semibold tabular text-[var(--success)]">{formatUsdcShort(session.totalFunded - session.totalSpent)}</span>
                    <span className="text-[var(--subtle)]">Per-call cap</span>
                    <span className="tabular">{formatUsdcShort(session.perPaymentCap)}</span>
                    <span className="text-[var(--subtle)]">Authorized agent</span>
                    <span className="flex items-center mono text-[var(--muted)]">
                      {formatAddr(session.agent)}
                      <CopyButton text={session.agent} />
                    </span>
                    <span className="text-[var(--subtle)]">Provider payout</span>
                    <span className="flex items-center mono text-[var(--muted)]">
                      {formatAddr(session.provider)}
                      <CopyButton text={session.provider} />
                    </span>
                  </div>
                  {!isAgentWallet && (
                    <div className="flex items-start gap-1.5 text-[var(--danger)] pt-1 border-t border-[var(--border)]">
                      <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                      <div className="space-y-1">
                        <p className="font-semibold">Wrong wallet for payment</p>
                        <p className="text-[var(--muted)]">
                          Connected: <span className="mono">{formatAddr(address!)}</span>
                          {isOwnerWallet ? " (owner — can read quotes but cannot pay)" : ""}.
                          Only agent <span className="mono">{formatAddr(session.agent)}</span> can pay.
                        </p>
                        {isOwnerWallet && (
                          <div className="rounded-lg bg-[var(--surface)] px-3 py-2 text-[var(--subtle)] space-y-0.5">
                            <p className="font-semibold">To pay as the agent:</p>
                            <p>Option 1: Switch to the agent wallet in your browser wallet extension.</p>
                            <p>Option 2: Run the agent CLI (see below).</p>
                            <p>Option 3: Create a new session (#5) with your connected wallet as both owner and agent.</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Agent CLI instructions */}
            {session && !isAgentWallet && (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 space-y-2 text-xs">
                <p className="font-semibold text-[var(--ink-2)]">Run via agent CLI (autonomous agent demo)</p>
                <p className="text-[var(--muted)]">
                  The CLI uses the agent private key directly and represents real autonomous agent execution — the owner is not involved in the payment step.
                </p>
                <div className="rounded-lg bg-[var(--surface-muted)] px-3 py-2 mono text-[var(--subtle)] space-y-0.5">
                  <p># Set agent key in agent.env (never committed)</p>
                  <p>AGENT_PRIVATE_KEY=0x… # agent wallet B private key</p>
                  <p>PROVIDER_API_URL=http://localhost:3001</p>
                  <p className="mt-1"># Run payment</p>
                  <p>cd agent && bun run demo -- --session {sessionIdInput || "1"} --text "your document"</p>
                  <p className="mt-1"># Or with a file</p>
                  <p>bun run demo -- --session {sessionIdInput || "1"} --text-file ./samples/doc.txt</p>
                </div>
                <p className="text-[var(--subtle)]">Add <span className="mono">--dry-run</span> to simulate without broadcasting.</p>
              </div>
            )}

            {/* Session 4 note: owner==agent */}
            {session && session.agent.toLowerCase() === session.owner.toLowerCase() && isAgentWallet && (
              <div className="rounded-xl border border-[rgba(141,216,159,0.2)] bg-[rgba(141,216,159,0.05)] px-4 py-2 text-xs text-[var(--muted)]">
                <Info size={11} className="inline mr-1 text-[var(--success)]" />
                Session {sessionIdInput} has the same address for owner and agent — you can pay directly from this wallet. This is valid for testing.
              </div>
            )}

            {/* Document input */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-sm font-medium text-[var(--ink-2)]" htmlFor="docText">
                  Document text
                </label>
                <button
                  onClick={() => setInputText(SAMPLE_DOCUMENT)}
                  className="text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
                >
                  Use sample
                </button>
              </div>
              <textarea
                id="docText"
                rows={7}
                value={inputText}
                onChange={e => setInputText(e.target.value)}
                placeholder="Paste your document here or click 'Use sample'…"
                className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]
                           px-3 py-2.5 text-sm text-[var(--ink)] placeholder:text-[var(--subtle)]
                           focus:outline-none focus:ring-2 focus:ring-[var(--focus)] resize-y min-h-[120px]"
              />
              <p className={`text-xs mt-1 tabular ${inputTooLarge ? "text-[var(--danger)]" : "text-[var(--subtle)]"}`}>
                {inputBytes.toLocaleString()} / {MAX_INPUT_BYTES.toLocaleString()} bytes
              </p>
            </div>

            {/* Simulation error shown inline (before flow starts) */}
            {flow.stage === "quote_ready" && flow.error && (
              <ErrorBanner message={flow.error} onDismiss={() => setFlow(f => ({ ...f, error: undefined }))} />
            )}

            {/* Flow progress */}
            {flow.stage !== "idle" && (
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
                <TransactionStepper steps={steps} className="mb-2" />

                {/* Pay error */}
                {flow.stage === "pay_error" && (
                  <div className="space-y-3">
                    <div className="rounded-xl border border-[var(--danger)] bg-[rgba(232,109,122,0.08)] px-4 py-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <AlertTriangle size={14} className="shrink-0 text-[var(--danger)]" />
                        <p className="text-sm font-semibold text-[var(--danger)]">
                          {flow.errorCode ? `[${flow.errorCode}] ` : ""}{flow.error ?? "Payment failed"}
                        </p>
                      </div>
                      {flow.errorAction && (
                        <p className="text-xs text-[var(--muted)] pl-5">{flow.errorAction}</p>
                      )}
                    </div>
                    <button
                      onClick={resetFlow}
                      className="w-full rounded-xl bg-[var(--surface-strong)] border border-[var(--border)]
                                 text-[var(--ink-2)] py-2.5 text-sm font-semibold hover:bg-[var(--surface-muted)] transition-colors"
                    >
                      Start over
                    </button>
                  </div>
                )}

                {/* Fulfill error (retryable — no new payment) */}
                {flow.stage === "fulfill_error" && (
                  <div className="space-y-3">
                    <div className="rounded-xl border border-amber-500/40 bg-amber-500/8 px-4 py-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <AlertTriangle size={14} className="shrink-0 text-amber-400" />
                        <p className="text-sm font-semibold text-amber-300">
                          {flow.errorCode ? `[${flow.errorCode}] ` : ""}{flow.error ?? "Fulfillment failed"}
                        </p>
                      </div>
                      {flow.errorAction && (
                        <p className="text-xs text-amber-200/70 pl-5">{flow.errorAction}</p>
                      )}
                    </div>
                    {flow.hash && <TxLink hash={flow.hash} label="Payment confirmed (view tx)" />}
                    <button
                      onClick={() => { handleRetryFulfill(); }}
                      className="w-full rounded-xl bg-[var(--surface-strong)] border border-[var(--border)]
                                 text-[var(--ink-2)] py-2.5 text-sm font-semibold hover:bg-[var(--surface-muted)] transition-colors"
                    >
                      Retry /api/fulfill — no new payment
                    </button>
                    <p className="text-xs text-[var(--subtle)]">
                      Your payment is already confirmed onchain. Only /api/fulfill is retried — no new USDC is charged.
                    </p>
                  </div>
                )}

                {/* Quote ready → show preview + pay button */}
                {flow.stage === "quote_ready" && flow.quote && (
                  <div className="space-y-4">
                    <div className="rounded-xl bg-[var(--surface-muted)] border border-[var(--border)] p-4 text-xs space-y-2">
                      <p className="font-semibold text-[var(--ink-2)]">Signed quote — ready for payment</p>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                        <span className="text-[var(--subtle)]">Service</span>
                        <span className="text-[var(--muted)]">{flow.quote.service}</span>

                        {/* V2: show base/fee/gross breakdown */}
                        {flow.quote.version === "2" && flow.quote.baseAmount && flow.quote.feeAmount ? (
                          <>
                            <span className="text-[var(--subtle)]">Provider base (C)</span>
                            <span className="tabular text-[var(--muted)]">{formatUsdcShort(BigInt(flow.quote.baseAmount))}</span>
                            <span className="text-[var(--subtle)]">Platform fee 0.5% (E)</span>
                            <span className="tabular text-[var(--muted)]">{formatUsdcShort(BigInt(flow.quote.feeAmount))}</span>
                            <span className="text-[var(--subtle)]">Gross charged from session</span>
                            <span className="font-bold text-[var(--success)] tabular text-sm">
                              {formatUsdcShort(BigInt(flow.quote.amount))}
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="text-[var(--subtle)]">USDC charge (V1 — no fee)</span>
                            <span className="font-bold text-[var(--success)] tabular text-sm">
                              {formatUsdcShort(BigInt(flow.quote.amount))}
                            </span>
                          </>
                        )}

                        <span className="text-[var(--subtle)]">Provider receives</span>
                        <span className="mono text-[var(--muted)]">{formatAddr(flow.quote.providerPayout)}</span>
                        <span className="text-[var(--subtle)]">Quote valid until</span>
                        <span className="text-[var(--muted)]">
                          {new Date(Number(flow.quote.quoteDeadline) * 1000).toLocaleTimeString()}
                          {" "}({Math.max(0, Number(flow.quote.quoteDeadline) - Math.floor(Date.now() / 1000))}s left)
                        </span>
                        <span className="text-[var(--subtle)]">Request ID</span>
                        <span className="mono text-[var(--muted)]">{flow.quote.requestId.slice(0, 20)}…</span>
                      </div>
                    </div>

                    {isAgentWallet ? (
                      <div className="space-y-2">
                        <button
                          onClick={() => { void handlePay(); }}
                          disabled={isWalletPending}
                          className="w-full rounded-xl bg-[var(--accent)] text-[#0d1b2f] py-3 font-semibold
                                     hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
                        >
                          Pay {formatUsdcShort(BigInt(flow.quote.amount))} USDC via BudgetRail
                        </button>
                        <p className="text-xs text-[var(--subtle)] text-center">
                          Manual demo mode — you are clicking as the agent. In production, the agent wallet calls payForRequest autonomously without owner involvement.
                        </p>
                      </div>
                    ) : (
                      <div className="rounded-xl bg-[rgba(232,109,122,0.08)] border border-[var(--danger)] px-4 py-3 space-y-1">
                        <p className="text-sm text-[var(--danger)] font-semibold">Switch to agent wallet B to pay</p>
                        <p className="text-xs text-[var(--muted)]">
                          The smart contract will reject any wallet other than <span className="mono">{session ? formatAddr(session.agent) : "—"}</span>.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Paying / confirming */}
                {(flow.stage === "paying" || flow.stage === "confirming_tx") && (
                  <div className="space-y-2">
                    <p className="text-sm text-[var(--muted)] animate-pulse">
                      {flow.stage === "paying" ? (isWalletPending ? "Waiting for wallet confirmation…" : "Simulating transaction…") : "Waiting for block confirmation…"}
                    </p>
                    {flow.hash && <TxLink hash={flow.hash} label="View transaction on explorer" />}
                  </div>
                )}

                {/* Fulfilling */}
                {flow.stage === "fulfilling" && (
                  <div className="space-y-2">
                    {flow.hash && <TxLink hash={flow.hash} label="Payment confirmed — view tx" />}
                    <p className="text-xs text-[var(--subtle)] animate-pulse">Calling /api/fulfill — provider is verifying payment receipt…</p>
                  </div>
                )}

                {/* Done */}
                {flow.stage === "done" && flow.result && flow.payment && (
                  <div className="space-y-4">
                    {/* Payment receipt */}
                    <div className="rounded-xl bg-[rgba(141,216,159,0.06)] border border-[rgba(141,216,159,0.2)] p-4 space-y-2">
                      <p className="font-semibold text-[var(--success)] text-sm">Payment verified + result delivered</p>
                      <TxLink hash={flow.payment.txHash} label="View settled transaction" />
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                        <span className="text-[var(--subtle)]">USDC paid (gross)</span>
                        <span className="tabular font-semibold">{flow.payment.amountUsdc}</span>
                        {/* V2 split — show base/fee if available */}
                        {flow.quote?.version === "2" && flow.quote.baseAmount && flow.quote.feeAmount && (
                          <>
                            <span className="text-[var(--subtle)] pl-3">Provider C received</span>
                            <span className="tabular">{formatUsdcShort(BigInt(flow.quote.baseAmount))}</span>
                            <span className="text-[var(--subtle)] pl-3">Treasury E fee</span>
                            <span className="tabular">{formatUsdcShort(BigInt(flow.quote.feeAmount))}</span>
                          </>
                        )}
                        {flow.quote?.version !== "2" && (
                          <>
                            <span className="text-[var(--subtle)] pl-3">V1 — fee</span>
                            <span className="tabular text-[var(--subtle)]">$0.000000 (no V1 fee)</span>
                          </>
                        )}
                        <span className="text-[var(--subtle)]">Session</span>
                        <span className="tabular">#{flow.payment.sessionId}</span>
                        <span className="text-[var(--subtle)]">Block</span>
                        <span className="tabular">{flow.payment.blockNumber ?? "—"}</span>
                      </div>
                    </div>

                    {/* Document result */}
                    <div className="rounded-xl bg-[var(--surface-muted)] border border-[var(--border)] p-4 space-y-3">
                      <p className="font-semibold text-[var(--ink-2)] text-sm">Document Insights — purchased result</p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
                        <div><p className="text-xs text-[var(--subtle)]">Words</p><p className="tabular font-semibold">{flow.result.wordCount}</p></div>
                        <div><p className="text-xs text-[var(--subtle)]">Sentences</p><p className="tabular font-semibold">{flow.result.sentenceCount}</p></div>
                        <div><p className="text-xs text-[var(--subtle)]">Paragraphs</p><p className="tabular font-semibold">{flow.result.paragraphCount}</p></div>
                        <div><p className="text-xs text-[var(--subtle)]">Characters</p><p className="tabular font-semibold">{flow.result.characterCount}</p></div>
                        <div><p className="text-xs text-[var(--subtle)]">Avg words/sent</p><p className="tabular font-semibold">{flow.result.avgWordsPerSentence?.toFixed(1)}</p></div>
                        <div><p className="text-xs text-[var(--subtle)]">Readability</p><p className="font-semibold capitalize">{flow.result.readabilityTier}</p></div>
                      </div>
                      {flow.result.extractiveSummary?.length > 0 && (
                        <div>
                          <p className="text-xs text-[var(--subtle)] mb-1.5">Summary</p>
                          {flow.result.extractiveSummary.map((s, i) => (
                            <p key={i} className="text-xs text-[var(--muted)] mb-1">• {s}</p>
                          ))}
                        </div>
                      )}
                      {flow.result.top10Keywords?.length > 0 && (
                        <div>
                          <p className="text-xs text-[var(--subtle)] mb-1">Top keywords</p>
                          <p className="text-xs text-[var(--muted)]">
                            {flow.result.top10Keywords.slice(0, 8).map(k => `${k.word} (${k.count})`).join("  ·  ")}
                          </p>
                        </div>
                      )}
                    </div>

                    <button
                      onClick={resetFlow}
                      className="w-full rounded-xl bg-[var(--surface-strong)] border border-[var(--border)]
                                 text-[var(--ink-2)] py-2.5 text-sm font-medium hover:bg-[var(--surface-muted)] transition-colors"
                    >
                      Analyze another document
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* CTA — request quote (shown when idle) */}
            {flow.stage === "idle" && (
              <button
                onClick={() => { void handleRequestQuote(); }}
                disabled={!sessionIdInput || !inputText.trim() || inputTooLarge || !PROVIDER_CONFIGURED}
                className="w-full rounded-xl bg-[var(--accent)] text-[#0d1b2f] py-3 font-semibold
                           hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
              >
                {!PROVIDER_CONFIGURED ? "Provider not configured" : "Request signed quote"}
              </button>
            )}

            {/* Bottom info */}
            <div className="flex gap-2 text-xs text-[var(--subtle)]">
              <Info size={13} className="shrink-0 mt-0.5 text-[var(--accent)]" />
              <p>
                Quotes can be requested with any connected wallet. Only agent wallet B can submit the payment.
                This is enforced by the BudgetRail smart contract, not by the UI.
              </p>
            </div>
          </div>
        )}
      </NetworkGuard>

      {/* Confirm pay modal */}
      {showConfirm && flow.stage === "quote_ready" && flow.quote && (
        <ConfirmModal
          title="Confirm USDC payment via BudgetRail"
          body={
            <div className="space-y-2 text-sm">
              <p><strong>Service:</strong> Document Insights v1</p>
              <p><strong>USDC charge:</strong> <span className="tabular">{formatUsdcShort(BigInt(flow.quote.amount))}</span></p>
              <p><strong>Provider receives:</strong> <span className="mono">{formatAddr(flow.quote.providerPayout)}</span></p>
              <p><strong>Session:</strong> #{flow.quote.sessionId}</p>
              <p><strong>Quote valid:</strong> {Math.max(0, Number(flow.quote.quoteDeadline) - Math.floor(Date.now() / 1000))}s remaining</p>
              <div className="rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-xs text-[var(--subtle)] mt-2 space-y-1">
                <p>A simulation runs first. Your wallet opens only if simulation passes.</p>
                <p>Payment is final once confirmed. The provider will independently verify the onchain receipt.</p>
              </div>
            </div>
          }
          confirmLabel="Pay now"
          onConfirm={() => { void onConfirmPay(); }}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </div>
  );
}
