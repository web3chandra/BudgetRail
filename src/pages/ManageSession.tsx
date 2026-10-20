/**
 * Page 5 — Manage Budget (/sessions/:id)
 *
 * Features:
 * - Live session state (auto-refetch).
 * - Close & Refund — owner-only, irreversible, with confirm modal.
 * - Add Funds (top-up) — owner-only, approve USDC then fundSession.
 *   Validates: not closed, not expired, cumulative cap (maxBudget), bigint math,
 *   no floating-point. Shows remaining top-up headroom and post-top-up balance preview.
 * - All state transitions in useEffect — no setState in render body.
 * - Wallet-switch detection: role labels / buttons refresh on account change.
 * - Old-signer compatibility warning for sessions using the previous quote signer.
 * - Reconciles chain state after every confirmed receipt.
 */
import { useState, useEffect, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import {
  useAccount, useReadContract, useWriteContract,
  useWaitForTransactionReceipt, useSwitchChain,
} from "wagmi";
import { erc20Abi, decodeEventLog } from "viem";
import { arcTestnet } from "viem/chains";
import { ArrowLeft, AlertTriangle, ShieldAlert, PlusCircle, Info } from "lucide-react";
import { getUsdc } from "@/onchain-facts";
import { BUDGET_RAIL_ABI, BUDGET_RAIL_ADDRESS, QUOTE_SIGNER } from "@/lib/budgetRail";
import { formatUsdcShort, formatAddr, formatTs, isExpired, sessionStatus } from "@/lib/format";
import { parseOnchainError } from "@/lib/parseOnchainError";
import { NetworkGuard } from "@/components/NetworkGuard";
import { TxLink, AddrLink } from "@/components/ExplorerLink";
import { TransactionStepper, type Step } from "@/components/TransactionStepper";
import { ErrorBanner, ConfirmModal, SkeletonCard, StatusBadge } from "@/components/shared";
import { WalletRolePanel } from "@/components/WalletRolePanel";
import { OwnershipProof } from "@/components/OwnershipProof";
import { toast } from "sonner";

const CHAIN_ID = arcTestnet.id;
const USDC     = getUsdc(CHAIN_ID)!;

// ── Parse helpers (bigint-only, no floating-point) ─────────────────────────

/** Parse a decimal USDC string to 6-decimal bigint units, null on invalid. */
function parseUsdcUnits(s: string): bigint | null {
  const t = s.trim();
  if (!t || !/^\d*\.?\d*$/.test(t) || t === "." || t === "") return null;
  const [whole, frac = ""] = t.split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  try {
    const v = BigInt(whole || "0") * 1_000_000n + BigInt(fracPadded);
    return v > 0n ? v : null;
  } catch { return null; }
}

// ── Flow types ──────────────────────────────────────────────────────────────

type CloseFlow = "idle" | "confirming" | "pending" | "done" | "error";
type TopUpFlow = "idle" | "form" | "confirming" | "approving" | "funding" | "done" | "error";

// ── Component ──────────────────────────────────────────────────────────────

export function ManageSession() {
  const { id } = useParams<{ id: string }>();
  const { address, isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();

  // ── Close flow state ──────────────────────────────────────────────────
  const [closeFlow, setCloseFlow] = useState<CloseFlow>("idle");
  const [closeError, setCloseError] = useState<string | null>(null);
  const [refundAmount, setRefundAmount] = useState<bigint | null>(null);

  // ── Top-up flow state ─────────────────────────────────────────────────
  const [topUpFlow, setTopUpFlow] = useState<TopUpFlow>("idle");
  const [topUpAmountInput, setTopUpAmountInput] = useState("");
  const [topUpError, setTopUpError] = useState<string | null>(null);
  const [topUpInputError, setTopUpInputError] = useState<string | null>(null);
  const [approveHash, setApproveHash] = useState<`0x${string}` | undefined>();
  const [fundHash, setFundHash] = useState<`0x${string}` | undefined>();

  const sessionId = (() => { try { return id ? BigInt(id) : null; } catch { return null; } })();

  // ── Session read ──────────────────────────────────────────────────────
  const { data: sessionData, isLoading, refetch } = useReadContract({
    address: BUDGET_RAIL_ADDRESS,
    abi: BUDGET_RAIL_ABI,
    functionName: "getSession",
    args: [sessionId ?? 0n],
    chainId: CHAIN_ID,
    query: {
      enabled: !!sessionId,
      refetchInterval: closeFlow === "idle" && topUpFlow === "idle" ? 20_000 : 3_000,
    },
  });
  const session = sessionData;

  // ── USDC balance for allowance check ─────────────────────────────────
  const { data: usdcBalance } = useReadContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    chainId: CHAIN_ID,
    query: { enabled: !!address, refetchInterval: 10_000 },
  });

  const { data: currentAllowance } = useReadContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: [
      address ?? "0x0000000000000000000000000000000000000000",
      BUDGET_RAIL_ADDRESS,
    ],
    chainId: CHAIN_ID,
    query: { enabled: !!address && topUpFlow !== "idle", refetchInterval: 5_000 },
  });

  // ── Role checks (re-evaluated on wallet switch) ───────────────────────
  const isOwner  = !!(session && address && session.owner.toLowerCase() === address.toLowerCase());
  const isWrongChain = isConnected && chainId !== CHAIN_ID;

  // ── Old-signer compatibility ──────────────────────────────────────────
  const signerMismatch = session && QUOTE_SIGNER !== "0x0000000000000000000000000000000000000000" &&
    session.quoteSigner.toLowerCase() !== QUOTE_SIGNER.toLowerCase() &&
    !session.closed;

  // ── Derived top-up math ───────────────────────────────────────────────
  const topUpUnits     = parseUsdcUnits(topUpAmountInput);
  const topUpHeadroom  = session ? session.maxBudget - session.totalFunded : 0n;
  const topUpAvailAfter = session && topUpUnits
    ? (session.totalFunded - session.totalSpent) + topUpUnits
    : null;
  const allowanceSufficient = topUpUnits !== null && currentAllowance !== undefined &&
    (currentAllowance) >= topUpUnits;

  // ── Close transaction hooks ───────────────────────────────────────────
  const {
    writeContract: closeSession,
    data:     closeHash,
    isPending:     isClosePending,
    isError:       isCloseWalletError,
    error:         closeWalletError,
  } = useWriteContract();
  const {
    isLoading: isCloseConfirming,
    isSuccess: isCloseSuccess,
    isError:   isCloseReceiptError,
    error:     closeReceiptError,
    data:      closeReceipt,
  } = useWaitForTransactionReceipt({ hash: closeHash });

  // Close — wallet rejection
  useEffect(() => {
    if (!isCloseWalletError || closeFlow !== "pending") return;
    setCloseFlow("idle");
    setCloseError(parseOnchainError(closeWalletError));
  }, [isCloseWalletError, closeWalletError, closeFlow]);

  // Close — receipt revert
  useEffect(() => {
    if (!isCloseReceiptError || closeFlow !== "pending") return;
    setCloseFlow("error");
    setCloseError(parseOnchainError(closeReceiptError));
  }, [isCloseReceiptError, closeReceiptError, closeFlow]);

  // Close — receipt success
  useEffect(() => {
    if (!isCloseSuccess || !closeReceipt || closeFlow !== "pending") return;
    for (const log of closeReceipt.logs) {
      if (log.address.toLowerCase() !== BUDGET_RAIL_ADDRESS.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: BUDGET_RAIL_ABI, data: log.data, topics: log.topics });
        if (decoded.eventName === "SessionClosed") {
          const args = decoded.args as unknown as { refunded: bigint };
          setRefundAmount(args.refunded);
          break;
        }
      } catch { /* different event */ }
    }
    setCloseFlow("done");
    toast.success("Session closed — refund sent to owner");
    void refetch();
  }, [isCloseSuccess, closeReceipt, closeFlow, refetch]);

  // ── Approve (top-up step 1) hooks ────────────────────────────────────
  const {
    writeContract: approveUsdc,
    data:     approveHashRaw,
    isPending:     isApprovePending,
    isError:       isApproveWalletError,
    error:         approveWalletError,
  } = useWriteContract();
  const {
    isSuccess: isApproveSuccess,
    isError:   isApproveReceiptError,
    error:     approveReceiptError,
  } = useWaitForTransactionReceipt({ hash: approveHashRaw });

  // Approve — wallet rejection
  useEffect(() => {
    if (!isApproveWalletError || topUpFlow !== "approving") return;
    setTopUpFlow("error");
    setTopUpError(`Approval rejected: ${parseOnchainError(approveWalletError)}`);
  }, [isApproveWalletError, approveWalletError, topUpFlow]);

  // Approve — receipt error
  useEffect(() => {
    if (!isApproveReceiptError || topUpFlow !== "approving") return;
    setTopUpFlow("error");
    setTopUpError(`Approval failed: ${parseOnchainError(approveReceiptError)}`);
  }, [isApproveReceiptError, approveReceiptError, topUpFlow]);

  // Approve — success → auto-advance to fund
  useEffect(() => {
    if (!isApproveSuccess || topUpFlow !== "approving") return;
    setApproveHash(approveHashRaw);
    toast.success("USDC approved — funding session…");
    setTopUpFlow("funding");
  }, [isApproveSuccess, approveHashRaw, topUpFlow]);

  // ── Fund (top-up step 2) hooks ────────────────────────────────────────
  const {
    writeContract: fundSession,
    data:     fundHashRaw,
    isPending:     isFundPending,
    isError:       isFundWalletError,
    error:         fundWalletError,
  } = useWriteContract();
  const {
    isSuccess: isFundSuccess,
    isError:   isFundReceiptError,
    error:     fundReceiptError,
    data:      fundReceipt,
  } = useWaitForTransactionReceipt({ hash: fundHashRaw });

  // Fund — wallet rejection
  useEffect(() => {
    if (!isFundWalletError || topUpFlow !== "funding") return;
    setTopUpFlow("error");
    setTopUpError(`Fund rejected: ${parseOnchainError(fundWalletError)}`);
  }, [isFundWalletError, fundWalletError, topUpFlow]);

  // Fund — receipt error
  useEffect(() => {
    if (!isFundReceiptError || topUpFlow !== "funding") return;
    setTopUpFlow("error");
    setTopUpError(`Fund failed: ${parseOnchainError(fundReceiptError)}`);
  }, [isFundReceiptError, fundReceiptError, topUpFlow]);

  // Fund — success
  useEffect(() => {
    if (!isFundSuccess || !fundReceipt || topUpFlow !== "funding") return;
    setFundHash(fundHashRaw);
    setTopUpFlow("done");
    toast.success("Session funded!");
    void refetch();
  }, [isFundSuccess, fundReceipt, fundHashRaw, topUpFlow, refetch]);

  // Auto-trigger fund after approve success
  const submitFund = useCallback((amount: bigint, sid: bigint) => {
    fundSession({
      address:      BUDGET_RAIL_ADDRESS,
      abi:          BUDGET_RAIL_ABI,
      functionName: "fundSession",
      args:         [sid, amount],
      chainId:      CHAIN_ID,
    });
  }, [fundSession]);

  useEffect(() => {
    if (topUpFlow !== "funding" || !sessionId || !topUpUnits) return;
    submitFund(topUpUnits, sessionId);
  // Only trigger when we enter "funding" state
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topUpFlow]);

  // ── Close handlers ────────────────────────────────────────────────────

  function handleCloseClick() {
    if (!isConnected || !isOwner) return;
    if (isWrongChain) { switchChain({ chainId: CHAIN_ID }); return; }
    setCloseFlow("confirming");
  }

  function onConfirmClose() {
    setCloseFlow("pending");
    setCloseError(null);
    closeSession({
      address:      BUDGET_RAIL_ADDRESS,
      abi:          BUDGET_RAIL_ABI,
      functionName: "closeSession",
      args:         [sessionId!],
      chainId:      CHAIN_ID,
    });
  }

  // ── Top-up handlers ───────────────────────────────────────────────────

  function handleTopUpClick() {
    if (!isConnected || !isOwner) return;
    if (isWrongChain) { switchChain({ chainId: CHAIN_ID }); return; }
    setTopUpFlow("form");
    setTopUpAmountInput("");
    setTopUpError(null);
    setTopUpInputError(null);
  }

  function validateTopUpAmount(): bigint | null {
    if (!topUpUnits || topUpUnits <= 0n) {
      setTopUpInputError("Enter a positive USDC amount");
      return null;
    }
    if (!session) { setTopUpInputError("Session not loaded"); return null; }
    if (topUpHeadroom <= 0n) {
      setTopUpInputError("Session is already fully funded to its max budget");
      return null;
    }
    if (topUpUnits > topUpHeadroom) {
      setTopUpInputError(`Exceeds remaining headroom of ${formatUsdcShort(topUpHeadroom)}`);
      return null;
    }
    if (usdcBalance !== undefined && topUpUnits > (usdcBalance)) {
      setTopUpInputError(`Insufficient USDC balance (have ${formatUsdcShort(usdcBalance)})`);
      return null;
    }
    setTopUpInputError(null);
    return topUpUnits;
  }

  function onConfirmTopUp() {
    const amount = validateTopUpAmount();
    if (!amount || !sessionId) return;
    setTopUpFlow(allowanceSufficient ? "funding" : "approving");
    setTopUpError(null);

    if (!allowanceSufficient) {
      approveUsdc({
        address:      USDC.address,
        abi:          erc20Abi,
        functionName: "approve",
        args:         [BUDGET_RAIL_ADDRESS, amount],
        chainId:      CHAIN_ID,
      });
    }
    // If allowanceSufficient, the "funding" useEffect triggers submitFund automatically
  }

  // ── Stepper definitions ───────────────────────────────────────────────

  const closeSteps: Step[] = [
    {
      id:     "close",
      label:  "Close session + refund",
      status: isClosePending || isCloseConfirming ? "active"
            : closeFlow === "done"  ? "success"
            : closeFlow === "error" ? "error"
            : "idle",
      detail: closeHash,
    },
  ];

  const topUpSteps: Step[] = [
    {
      id:     "approve",
      label:  allowanceSufficient ? "Approve USDC (skipped — allowance sufficient)" : `Approve ${topUpUnits ? formatUsdcShort(topUpUnits) : "…"} USDC`,
      status: allowanceSufficient && topUpFlow !== "idle" ? "success"
            : topUpFlow === "approving" ? "active"
            : topUpFlow === "funding" || topUpFlow === "done" ? "success"
            : topUpFlow === "error" && !approveHash ? "error"
            : "idle",
      detail: approveHash,
    },
    {
      id:     "fund",
      label:  `Fund session`,
      status: topUpFlow === "funding" ? "active"
            : topUpFlow === "done"    ? "success"
            : topUpFlow === "error" && approveHash ? "error"
            : "idle",
      detail: fundHash,
    },
  ];

  // ── Early exit: invalid ID ────────────────────────────────────────────

  if (!sessionId) {
    return (
      <div className="space-y-4">
        <Link to="/" className="inline-flex items-center gap-1 text-sm text-[var(--accent)] hover:text-[var(--accent-hover)]">
          <ArrowLeft size={14} /> Dashboard
        </Link>
        <ErrorBanner message="Invalid session ID in URL." />
      </div>
    );
  }

  // ── Derived display values ────────────────────────────────────────────

  const availableNow  = session ? session.totalFunded - session.totalSpent : 0n;
  const status        = session ? sessionStatus(session.closed, session.expiresAt) : "active";
  const canAddFunds   = !!(session && !session.closed && !isExpired(session.expiresAt) && topUpHeadroom > 0n);
  const isFullyFunded = session ? session.totalFunded >= session.maxBudget : false;

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="max-w-xl space-y-6">
      {/* Back nav */}
      <div className="flex items-center gap-3">
        <Link to="/" className="text-[var(--subtle)] hover:text-[var(--ink)] transition-colors" aria-label="Back">
          <ArrowLeft size={20} />
        </Link>
        <div>
          <h1 className="display font-bold text-2xl text-[var(--ink)] tracking-tight">
            Session #{sessionId.toString()}
          </h1>
          <p className="text-sm text-[var(--subtle)]">Add funds or close and refund</p>
        </div>
      </div>

      <NetworkGuard readOnly>
        {isLoading ? (
          <SkeletonCard />
        ) : !session || session.owner === "0x0000000000000000000000000000000000000000" ? (
          <ErrorBanner message={`Session ${sessionId} not found on Arc Testnet.`} />
        ) : (
          <>
            {/* Old-signer compatibility warning */}
            {signerMismatch && (
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/8 px-4 py-3 flex items-start gap-2">
                <AlertTriangle size={14} className="shrink-0 text-amber-400 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-amber-300">Quote signer mismatch</p>
                  <p className="text-xs text-amber-200/70">
                    This session was created with quote signer <span className="mono">{formatAddr(session.quoteSigner)}</span>,
                    but the current provider uses <span className="mono">{formatAddr(QUOTE_SIGNER)}</span>.
                    Quotes for this session will be rejected. Create a new session with the current quote signer to use the active provider.
                  </p>
                </div>
              </div>
            )}

            {/* Session parameters */}
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
              <div className="flex items-center justify-between">
                <p className="display font-semibold text-lg text-[var(--ink)]">Session parameters</p>
                <StatusBadge status={status} />
              </div>

              <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <div><p className="text-xs text-[var(--subtle)] mb-0.5">Owner</p><AddrLink address={session.owner} /></div>
                <div><p className="text-xs text-[var(--subtle)] mb-0.5">Agent</p><AddrLink address={session.agent} /></div>
                <div><p className="text-xs text-[var(--subtle)] mb-0.5">Provider payout</p><AddrLink address={session.provider} /></div>
                <div><p className="text-xs text-[var(--subtle)] mb-0.5">Quote signer</p><AddrLink address={session.quoteSigner} /></div>
              </div>

              {/* Money stats grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {[
                  { label: "Max budget",          val: formatUsdcShort(session.maxBudget),    sub: "Lifetime ceiling" },
                  { label: "Total funded",         val: formatUsdcShort(session.totalFunded),  sub: "Cumulative deposits" },
                  { label: "Total spent",          val: formatUsdcShort(session.totalSpent),   sub: "Agent payments" },
                  { label: "Available now",        val: formatUsdcShort(availableNow),         sub: "funded − spent", highlight: true },
                  { label: "Top-up headroom",      val: formatUsdcShort(topUpHeadroom),        sub: "maxBudget − funded" },
                  { label: "Expires",              val: isExpired(session.expiresAt) ? "Expired" : formatTs(session.expiresAt), sub: "" },
                ].map(({ label, val, sub, highlight }) => (
                  <div key={label} className="rounded-xl bg-[var(--surface-muted)] border border-[var(--border)] px-3 py-2.5">
                    <p className="text-xs text-[var(--subtle)]">{label}</p>
                    <p className={`font-semibold tabular text-sm mt-0.5 ${highlight ? "text-[var(--success)]" : "text-[var(--ink)]"}`}>
                      {val}
                    </p>
                    {sub && <p className="text-xs text-[var(--subtle)] mt-0.5">{sub}</p>}
                  </div>
                ))}
              </div>

              {/* Top-up headroom note */}
              {isFullyFunded && !session.closed && (
                <div className="flex items-start gap-2 text-xs text-[var(--subtle)]">
                  <Info size={12} className="shrink-0 mt-0.5" />
                  <p>Session is fully funded to its max budget. To fund more, create a new session with a larger max budget.</p>
                </div>
              )}
            </div>

            {/* Who gets paid? — role panel with immutable chain state */}
            <WalletRolePanel
              ownerAddress={address}
              session={session}
              contractVersion="V1"
              collapsed
            />

            {/* Ownership proof — operator can verify C or D ownership */}
            {session.provider !== "0x0000000000000000000000000000000000000000" && (
              <OwnershipProof
                claimAddress={session.provider}
                roleLabel="Provider payout C"
              />
            )}

            {/* ── ADD FUNDS (top-up) section ──────────────────────────────── */}

            {/* Add Funds — form or in-progress */}
            {topUpFlow === "idle" && (
              <>
                {!isConnected ? (
                  <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                    <p className="text-sm text-[var(--subtle)]">Connect owner wallet A to add funds.</p>
                  </div>
                ) : !isOwner ? (
                  <div className="flex items-start gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                    <AlertTriangle size={14} className="shrink-0 text-[var(--subtle)] mt-0.5" />
                    <p className="text-sm text-[var(--subtle)]">
                      Only the session owner (<span className="mono">{formatAddr(session.owner)}</span>) can add funds.
                      Connected: <span className="mono">{formatAddr(address!)}</span>
                    </p>
                  </div>
                ) : session.closed ? (
                  <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3">
                    <p className="text-sm text-[var(--subtle)]">Session closed — no further deposits possible.</p>
                  </div>
                ) : isExpired(session.expiresAt) ? (
                  <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3">
                    <p className="text-sm text-[var(--subtle)]">Session expired — close it to recover remaining funds.</p>
                  </div>
                ) : (
                  <button
                    onClick={handleTopUpClick}
                    disabled={!canAddFunds}
                    className="w-full rounded-xl border border-[var(--accent)] text-[var(--accent)] bg-transparent py-3 font-semibold
                               hover:bg-[rgba(66,184,224,0.08)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors
                               flex items-center justify-center gap-2"
                  >
                    <PlusCircle size={16} />
                    {isFullyFunded ? "Fully funded (no headroom)" : `Add Funds — up to ${formatUsdcShort(topUpHeadroom)} more`}
                  </button>
                )}
              </>
            )}

            {/* Top-up form */}
            {topUpFlow === "form" && (
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <p className="display font-semibold text-base text-[var(--ink-2)]">Add Funds</p>
                  <button
                    onClick={() => { setTopUpFlow("idle"); setTopUpAmountInput(""); setTopUpError(null); }}
                    className="text-xs text-[var(--subtle)] hover:text-[var(--muted)] transition-colors"
                  >
                    Cancel
                  </button>
                </div>

                <div className="space-y-1">
                  <label className="block text-sm font-medium text-[var(--ink-2)]" htmlFor="topUpAmount">
                    Amount (USDC)
                  </label>
                  <input
                    id="topUpAmount"
                    type="text"
                    inputMode="decimal"
                    value={topUpAmountInput}
                    onChange={e => { setTopUpAmountInput(e.target.value); setTopUpInputError(null); }}
                    placeholder="0.00"
                    className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]
                               px-3 py-2.5 text-sm tabular text-[var(--ink)]
                               focus:outline-none focus:ring-2 focus:ring-[var(--focus)]"
                  />
                  {topUpInputError && <p className="text-xs text-[var(--danger)]">{topUpInputError}</p>}
                </div>

                {/* Preview */}
                {!!topUpUnits && topUpUnits > 0n && (
                  <div className="rounded-xl bg-[var(--surface-muted)] border border-[var(--border)] px-4 py-3 text-xs space-y-1.5">
                    <p className="font-semibold text-[var(--ink-2)]">Deposit preview</p>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                      <span className="text-[var(--subtle)]">Adding</span>
                      <span className="tabular font-semibold text-[var(--accent)]">{formatUsdcShort(topUpUnits)}</span>
                      <span className="text-[var(--subtle)]">Total funded after</span>
                      <span className="tabular">{formatUsdcShort(session.totalFunded + topUpUnits)}</span>
                      <span className="text-[var(--subtle)]">Available after</span>
                      <span className="tabular text-[var(--success)]">{topUpAvailAfter !== null ? formatUsdcShort(topUpAvailAfter) : "—"}</span>
                      <span className="text-[var(--subtle)]">Remaining headroom after</span>
                      <span className="tabular">{formatUsdcShort(topUpHeadroom - topUpUnits)}</span>
                      <span className="text-[var(--subtle)]">Allowance needed</span>
                      <span className="tabular">{allowanceSufficient ? "None (sufficient)" : formatUsdcShort(topUpUnits)}</span>
                      <span className="text-[var(--subtle)]">Recipient</span>
                      <span className="mono">{formatAddr(BUDGET_RAIL_ADDRESS)}</span>
                    </div>
                    <p className="text-[var(--subtle)] border-t border-[var(--border)] pt-1.5">
                      Funds are credited to session #{sessionId.toString()}.
                      Only the owner can close and recover unspent funds.
                      Direct transfers to the contract are uncredited and unrecoverable.
                    </p>
                  </div>
                )}

                <button
                  onClick={() => {
                    const v = validateTopUpAmount();
                    if (v) setTopUpFlow("confirming");
                  }}
                  disabled={!topUpUnits || topUpUnits <= 0n}
                  className="w-full rounded-xl bg-[var(--accent)] text-[#0d1b2f] py-3 font-semibold
                             hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
                >
                  Review deposit
                </button>
              </div>
            )}

            {/* Top-up in progress */}
            {(topUpFlow === "approving" || topUpFlow === "funding" || topUpFlow === "done" || topUpFlow === "error") && (
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
                <p className="display font-semibold text-base text-[var(--ink-2)]">Add Funds — in progress</p>
                <TransactionStepper steps={topUpSteps} />

                {topUpError && <ErrorBanner message={topUpError} onDismiss={() => setTopUpError(null)} />}

                {topUpFlow === "done" && (
                  <div className="rounded-xl bg-[rgba(141,216,159,0.08)] border border-[rgba(141,216,159,0.2)] px-4 py-3 space-y-1">
                    <p className="font-semibold text-[var(--success)] text-sm">Funds added successfully</p>
                    {!!topUpUnits && (
                      <p className="text-xs text-[var(--muted)]">
                        Added {formatUsdcShort(topUpUnits)} to session #{sessionId.toString()}
                      </p>
                    )}
                    {fundHash && <TxLink hash={fundHash} label="View fund tx" />}
                    <button
                      onClick={() => { setTopUpFlow("idle"); setTopUpAmountInput(""); setApproveHash(undefined); setFundHash(undefined); }}
                      className="mt-2 text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
                    >
                      Add more funds
                    </button>
                  </div>
                )}

                {topUpFlow === "error" && (
                  <button
                    onClick={() => { setTopUpFlow("form"); setTopUpError(null); setApproveHash(undefined); setFundHash(undefined); }}
                    className="w-full rounded-xl bg-[var(--surface-strong)] border border-[var(--border)]
                               text-[var(--ink-2)] py-2.5 text-sm font-semibold hover:bg-[var(--surface-muted)] transition-colors"
                  >
                    Try again
                  </button>
                )}

                {(topUpFlow === "approving" || topUpFlow === "funding") && (
                  <div>
                    <p className="text-sm text-[var(--muted)] animate-pulse">
                      {isApprovePending || (topUpFlow === "approving" && !approveHash)
                        ? "Waiting for approval confirmation in wallet…"
                        : isFundPending || topUpFlow === "funding"
                        ? "Funding session — confirm in wallet…"
                        : "Confirming on chain…"}
                    </p>
                    {approveHash && <TxLink hash={approveHash} label="View approval tx" className="mt-1" />}
                  </div>
                )}
              </div>
            )}

            {/* ── CLOSE SESSION section ───────────────────────────────────── */}

            {/* Risk disclosure */}
            <div className="rounded-xl border border-[rgba(232,109,122,0.25)] bg-[rgba(232,109,122,0.05)] px-4 py-3 space-y-1.5">
              <div className="flex items-center gap-2 text-[var(--danger)]">
                <ShieldAlert size={15} />
                <p className="text-sm font-semibold">Closing is irreversible</p>
              </div>
              <p className="text-xs text-[var(--muted)]">
                Closing returns the remaining funded balance ({formatUsdcShort(availableNow)}) to the owner.
                Payments already settled to the provider cannot be reversed — only future payments are blocked.
                The session cannot be reopened after closing.
              </p>
            </div>

            {closeError && <ErrorBanner message={closeError} onDismiss={() => setCloseError(null)} />}

            {/* Close in-progress */}
            {closeFlow !== "idle" && closeFlow !== "confirming" && (
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
                <p className="display font-semibold text-base text-[var(--ink-2)]">Close & Refund</p>
                <TransactionStepper steps={closeSteps} />

                {closeFlow === "done" && (
                  <div className="rounded-xl bg-[rgba(141,216,159,0.08)] border border-[rgba(141,216,159,0.2)] px-4 py-3 space-y-1">
                    <p className="font-semibold text-[var(--success)] text-sm">Session closed</p>
                    {refundAmount !== null && (
                      <p className="text-xs text-[var(--muted)]">Refunded: {formatUsdcShort(refundAmount)} USDC to owner</p>
                    )}
                    {closeHash && <TxLink hash={closeHash} label="View close tx" />}
                  </div>
                )}
              </div>
            )}

            {/* Close button area */}
            {!isConnected ? (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                <p className="text-sm text-[var(--subtle)]">Connect owner wallet A to close this session.</p>
              </div>
            ) : !isOwner ? (
              <div className="flex items-start gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                <AlertTriangle size={14} className="shrink-0 text-[var(--subtle)] mt-0.5" />
                <p className="text-sm text-[var(--subtle)]">
                  Only the session owner (<span className="mono">{formatAddr(session.owner)}</span>) can close.
                  Connected: <span className="mono">{formatAddr(address!)}</span>
                </p>
              </div>
            ) : session.closed || closeFlow === "done" ? (
              <button disabled className="w-full rounded-xl bg-[var(--surface-muted)] border border-[var(--border)]
                                          text-[var(--subtle)] py-3 font-semibold cursor-not-allowed">
                Session already closed
              </button>
            ) : closeFlow === "error" ? (
              <button
                onClick={() => { setCloseFlow("idle"); setCloseError(null); }}
                className="w-full rounded-xl bg-[var(--surface-strong)] border border-[var(--border)]
                           text-[var(--ink-2)] py-3 font-semibold hover:bg-[var(--surface-muted)] transition-colors"
              >
                Retry Close &amp; Refund
              </button>
            ) : (
              <button
                onClick={handleCloseClick}
                disabled={closeFlow === "pending" || isClosePending || isCloseConfirming}
                className="w-full rounded-xl bg-[var(--danger)] text-white py-3 font-semibold
                           hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {closeFlow === "pending" || isClosePending ? "Confirm in wallet…"
                : isCloseConfirming ? "Closing session…"
                : `Close & Refund ${formatUsdcShort(availableNow)}`}
              </button>
            )}

            <p className="text-xs text-[var(--subtle)]">
              Refund is sent directly to the session owner address. No arbitrary destination.
            </p>
          </>
        )}
      </NetworkGuard>

      {/* Close confirm modal */}
      {closeFlow === "confirming" && !!session && (
        <ConfirmModal
          title="Close session and refund?"
          body={
            <div className="space-y-2 text-sm">
              <p>Refund amount: <strong className="tabular">{formatUsdcShort(availableNow)}</strong> USDC</p>
              <p>Recipient: <span className="mono">{formatAddr(session.owner)}</span> (owner)</p>
              <p className="text-xs text-[var(--subtle)] mt-2">
                This permanently closes the session. Agent payments already settled are not reversed.
                The agent can no longer make payments after this.
              </p>
            </div>
          }
          confirmLabel="Close & Refund"
          cancelLabel="Keep open"
          danger
          onConfirm={onConfirmClose}
          onCancel={() => setCloseFlow("idle")}
        />
      )}

      {/* Top-up confirm modal */}
      {topUpFlow === "confirming" && !!session && !!topUpUnits && (
        <ConfirmModal
          title="Confirm top-up deposit?"
          body={
            <div className="space-y-2 text-sm">
              <p>Adding: <strong className="tabular">{formatUsdcShort(topUpUnits)}</strong> USDC</p>
              <p>Total funded after: <span className="tabular">{formatUsdcShort(session.totalFunded + topUpUnits)}</span></p>
              <p>Available after: <span className="tabular text-[var(--success)]">{topUpAvailAfter !== null ? formatUsdcShort(topUpAvailAfter) : "—"}</span></p>
              <p>Recipient contract: <span className="mono text-xs">{BUDGET_RAIL_ADDRESS}</span></p>
              {!allowanceSufficient && (
                <p className="text-xs text-[var(--subtle)]">Step 1: Approve USDC (exact amount only). Step 2: Fund session.</p>
              )}
              <p className="text-xs text-[var(--subtle)] mt-2">
                Only the owner can close and recover unspent funds. Direct transfers to the contract are unrecoverable.
              </p>
            </div>
          }
          confirmLabel={allowanceSufficient ? "Fund Session" : "Approve then Fund"}
          onConfirm={onConfirmTopUp}
          onCancel={() => { setTopUpFlow("form"); }}
        />
      )}
    </div>
  );
}
