/**
 * Page 2 — Create Budget (/create)
 * Multi-step: createSession → approve USDC → fundSession.
 *
 * Uses useSessionFlow for the full 8-state transaction lifecycle.
 * Preflight: provider configuration guard + simulateContract before wallet opens.
 * Recovery: resumes from localStorage-persisted state after refresh.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount, useReadContract, useSwitchChain } from "wagmi";
import { erc20Abi } from "viem";
import { AlertTriangle, Users, Info } from "lucide-react";
import { ARC } from "@/lib/arcProfile";
import { getUsdc } from "@/onchain-facts";
import {
  BUDGET_RAIL_ADDRESS,
  PROVIDER_PAYOUT,
  QUOTE_SIGNER,
  PROVIDER_CONFIGURED,
  providerConfigError,
} from "@/lib/budgetRail";
import {
  useSessionFlow,
  parseUsdcUnits,
  isValidAddress,
  type FormValues,
} from "@/hooks/useSessionFlow";
import { formatUsdcShort, formatAddr } from "@/lib/format";
import { NetworkGuard } from "@/components/NetworkGuard";
import { TransactionStepper, type Step } from "@/components/TransactionStepper";
import { TxLink } from "@/components/ExplorerLink";
import { ErrorBanner, ConfirmModal } from "@/components/shared";
import { WalletRolePanel } from "@/components/WalletRolePanel";
import { VersionBanner } from "@/components/VersionBanner";
import { V2_CONFIGURED } from "@/lib/budgetRail";
import { computeFeeV2 } from "@/lib/budgetRailV2";
import { toast } from "sonner";

// Use the active network profile — never hardcode arcTestnet.id.
const CHAIN_ID = ARC.chainId;
const USDC     = getUsdc(CHAIN_ID)!;

// ── Validation ────────────────────────────────────────────────────────────

function validate(
  form: FormValues,
  usdcBalance: bigint | undefined,
): Partial<Record<keyof FormValues, string>> {
  const e: Partial<Record<keyof FormValues, string>> = {};

  if (!isValidAddress(form.agentAddress)) {
    e.agentAddress = "Must be a valid 0x… Ethereum address";
  }
  if (form.agentAddress.toLowerCase() === PROVIDER_PAYOUT.toLowerCase() ||
      form.agentAddress.toLowerCase() === QUOTE_SIGNER.toLowerCase()) {
    e.agentAddress = "Agent address must differ from provider and signer addresses";
  }

  const maxBudgetUnits = parseUsdcUnits(form.maxBudget);
  if (!maxBudgetUnits || maxBudgetUnits < 1n) {
    e.maxBudget = "Must be > $0.000001";
  }

  const capUnits = parseUsdcUnits(form.perPaymentCap);
  if (!capUnits || capUnits < 1n) {
    e.perPaymentCap = "Must be > $0.000001";
  }
  if (maxBudgetUnits && capUnits && capUnits > maxBudgetUnits) {
    e.perPaymentCap = "Per-call cap cannot exceed max budget";
  }

  const days = parseInt(form.expiryDays, 10);
  if (!isFinite(days) || days < 1 || days > 3650) {
    e.expiryDays = "Must be 1–3650 days";
  }

  const fundUnits = parseUsdcUnits(form.fundAmount);
  if (!fundUnits || fundUnits < 1n) {
    e.fundAmount = "Must be > $0.000001";
  }
  if (maxBudgetUnits && fundUnits && fundUnits > maxBudgetUnits) {
    e.fundAmount = "Cannot fund more than max budget";
  }
  if (fundUnits && usdcBalance !== undefined && fundUnits > usdcBalance) {
    e.fundAmount = `Insufficient USDC: have ${formatUsdcShort(usdcBalance)}, need ${formatUsdcShort(fundUnits)}`;
  }

  return e;
}

// ── Stepper helpers ───────────────────────────────────────────────────────

function txStatusToStepStatus(
  status: "idle" | "validating" | "awaiting_signature" | "submitted" | "confirming" | "confirmed" | "failed" | "cancelled",
): "idle" | "active" | "success" | "error" {
  if (status === "confirmed") return "success";
  if (status === "failed" || status === "cancelled") return "error";
  if (status === "validating" || status === "awaiting_signature" || status === "submitted" || status === "confirming") return "active";
  return "idle";
}

function txStatusLabel(
  status: "idle" | "validating" | "awaiting_signature" | "submitted" | "confirming" | "confirmed" | "failed" | "cancelled",
  defaultLabel: string,
): string {
  switch (status) {
    case "validating":        return "Simulating…";
    case "awaiting_signature":return "Confirm in wallet…";
    case "submitted":         return "Submitted — waiting for block…";
    case "confirming":        return "Mining…";
    case "confirmed":         return "Confirmed";
    case "failed":            return "Failed";
    case "cancelled":         return "Cancelled";
    default:                  return defaultLabel;
  }
}

// ── Page ──────────────────────────────────────────────────────────────────

export function CreateBudget() {
  const { address, isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const navigate = useNavigate();

  const {
    form, setForm,
    flow,
    submitCreate, submitApprove, submitFund,
    dismissError, resetFlow,
    isCreating, isApproving, isFunding,
  } = useSessionFlow(address);

  const [formErrors, setFormErrors] = useState<Partial<Record<keyof FormValues, string>>>({});
  const [showConfirm, setShowConfirm] = useState(false);

  // USDC balance for validation
  const { data: usdcBalance } = useReadContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    chainId: CHAIN_ID,
    query: { enabled: !!address, refetchInterval: 10_000 },
  });

  // ── Handlers ─────────────────────────────────────────────────────────

  function handleCreate() {
    if (!isConnected || !address) return;
    if (chainId !== CHAIN_ID) { switchChain({ chainId: CHAIN_ID }); return; }
    if (!PROVIDER_CONFIGURED) return;
    const errs = validate(form, usdcBalance);
    setFormErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setShowConfirm(true);
  }

  function onConfirmCreate() {
    setShowConfirm(false);
    const maxBudgetUnits = parseUsdcUnits(form.maxBudget)!;
    const capUnits       = parseUsdcUnits(form.perPaymentCap)!;
    const expiresAt      = BigInt(Math.floor(Date.now() / 1000) + parseInt(form.expiryDays, 10) * 86400);
    void submitCreate(form.agentAddress as `0x${string}`, maxBudgetUnits, capUnits, expiresAt);
  }

  const handleApprove = useCallback(() => {
    if (!flow.sessionId) return;
    const fundUnits = parseUsdcUnits(form.fundAmount);
    if (!fundUnits) return;
    void submitApprove(flow.sessionId, fundUnits);
  }, [flow.sessionId, form.fundAmount, submitApprove]);

  const handleFund = useCallback(() => {
    if (!flow.sessionId) return;
    const fundUnits = parseUsdcUnits(form.fundAmount);
    if (!fundUnits) return;
    void submitFund(flow.sessionId, fundUnits);
  }, [flow.sessionId, form.fundAmount, submitFund]);

  // Navigate after done — useEffect, not render body
  useEffect(() => {
    if (flow.step !== "done" || !flow.sessionId) return;
    toast.success(`Session #${flow.sessionId} is live and funded!`);
    const t = setTimeout(() => { void navigate(`/sessions/${flow.sessionId}`); }, 1500);
    return () => clearTimeout(t);
  }, [flow.step, flow.sessionId, navigate]);

  // ── Stepper steps ─────────────────────────────────────────────────────

  const steps: Step[] = [
    {
      id: "create",
      label: txStatusLabel(flow.createStatus, "Create session"),
      status: txStatusToStepStatus(flow.createStatus),
      detail: flow.createHash,
    },
    {
      id: "approve",
      label: txStatusLabel(flow.approveStatus, `Approve ${formatUsdcShort(parseUsdcUnits(form.fundAmount) ?? 0n)} USDC`),
      status: txStatusToStepStatus(flow.approveStatus),
      detail: flow.approveHash,
    },
    {
      id: "fund",
      label: txStatusLabel(flow.fundStatus, "Fund session"),
      status: txStatusToStepStatus(flow.fundStatus),
      detail: flow.fundHash,
    },
  ];

  // ── Provider unconfigured banner ──────────────────────────────────────

  const configErr = providerConfigError();

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="max-w-xl space-y-8">
      <div>
        <h1 className="display font-bold text-2xl text-[var(--ink)] tracking-tight">New Budget Session</h1>
        <p className="text-sm text-[var(--subtle)] mt-1">
          Create a bounded USDC payment session for an authorized agent.
        </p>
      </div>

      {/* Version + network banner */}
      <VersionBanner version="V1" />

      {/* V2 availability notice */}
      {V2_CONFIGURED && (
        <div className="rounded-xl border border-[rgba(141,216,159,0.25)] bg-[rgba(141,216,159,0.05)] px-4 py-3 flex items-start gap-2">
          <Info size={13} className="shrink-0 text-[var(--success)] mt-0.5" />
          <div className="space-y-0.5 text-xs">
            <p className="font-semibold text-[var(--success)]">V2 contract is deployed</p>
            <p className="text-[var(--muted)]">
              V2 sessions add a 0.5% platform fee on service purchases only.
              For base $0.05: provider receives $0.050000, platform fee $0.000250, gross $0.050250.
              Deposits, top-ups, and refunds have NO platform fee.
              V1 sessions remain under V1 rules — no fee, no migration.
              <strong className="text-[var(--ink-2)]"> This form creates a V1 session.</strong>
            </p>
          </div>
        </div>
      )}

      {/* Provider configuration warning */}
      {configErr && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/8 px-4 py-3 flex items-start gap-3">
          <AlertTriangle size={16} className="shrink-0 text-amber-400 mt-0.5" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-amber-300">Provider not configured</p>
            <p className="text-xs text-amber-200/80">{configErr}</p>
          </div>
        </div>
      )}

      {/* Who gets paid? — always visible, collapsed by default before form */}
      <WalletRolePanel
        ownerAddress={address}
        connectedAddress={address}
        agentAddress={
          isValidAddress(form.agentAddress)
            ? form.agentAddress
            : undefined
        }
        contractVersion="V1"
        collapsed
      />

      <NetworkGuard>
        {!isConnected ? (
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center space-y-4">
            <p className="text-[var(--muted)]">Connect wallet A (owner) to create a session.</p>
          </div>
        ) : (
          <>
            {/* Error banners */}
            {flow.simError && (
              <ErrorBanner
                message={
                  flow.simError.includes("503") || flow.simError.includes("RPC") || flow.simError.includes("fetch")
                    ? `RPC temporarily unavailable — no funds spent, no transaction sent. Retry in a moment. (${flow.simError})`
                    : `Simulation failed — no gas spent, no transaction opened. ${flow.simError}`
                }
                onDismiss={dismissError}
              />
            )}
            {flow.txError && (
              <ErrorBanner
                message={flow.txError}
                onDismiss={dismissError}
              />
            )}

            {/* Form — shown while on "form" step */}
            {(flow.step === "form") && (
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 space-y-5">

                {/* Connected owner A — always visible, never auto-filled from agent field */}
                <div className="rounded-xl bg-[rgba(66,184,224,0.06)] border border-[rgba(66,184,224,0.2)] px-4 py-3">
                  <p className="text-xs font-semibold text-[var(--accent)] uppercase tracking-wider mb-1">
                    Connected owner A — signs &amp; broadcasts the transaction
                  </p>
                  <p className="mono text-sm text-[var(--ink)]">{address}</p>
                  <p className="text-xs text-[var(--subtle)] mt-0.5">
                    This wallet will be recorded onchain as the session owner. Only it can fund or close.
                  </p>
                </div>

                {/* Agent address */}
                <div>
                  <label className="block text-sm font-medium text-[var(--ink-2)] mb-1.5" htmlFor="agent">
                    Authorized agent B <span className="text-[var(--danger)]">*</span>
                    <span className="ml-1 text-xs font-normal text-[var(--subtle)]">— the wallet allowed to pay from this session</span>
                  </label>
                  <input
                    id="agent"
                    type="text"
                    value={form.agentAddress}
                    onChange={e => setForm(f => ({ ...f, agentAddress: e.target.value }))}
                    placeholder="0x…"
                    className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]
                               px-3 py-2.5 text-sm mono text-[var(--ink)] placeholder:text-[var(--subtle)]
                               focus:outline-none focus:ring-2 focus:ring-[var(--focus)]"
                  />
                  {formErrors.agentAddress && (
                    <p className="text-xs text-[var(--danger)] mt-1">{formErrors.agentAddress}</p>
                  )}

                  {/* A = B wizard guidance */}
                  {isValidAddress(form.agentAddress) && address &&
                    form.agentAddress.toLowerCase() === address.toLowerCase() && (
                    <div className="mt-2 flex items-start gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5">
                      <Users size={13} className="shrink-0 text-[var(--accent)] mt-0.5" />
                      <div className="space-y-0.5">
                        <p className="text-xs font-semibold text-[var(--ink-2)]">Same-wallet demo mode (A = B)</p>
                        <p className="text-xs text-[var(--subtle)] text-pretty">
                          Agent B is the same as owner A. This is useful for manual testing — you can create, fund, and pay
                          from one wallet. For a live integration, set B to a separate agent wallet that runs autonomously.
                        </p>
                        <p className="text-xs text-[var(--subtle)]">
                          Note: as agent B, you will also need gas to call <span className="mono">payForRequest</span>.
                          On Arc Testnet, USDC doubles as gas.
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Fixed provider info */}
                <div className="rounded-xl bg-[var(--surface-muted)] border border-[var(--border)] p-4 space-y-2">
                  <p className="text-xs font-semibold text-[var(--subtle)] uppercase tracking-wider">Fixed provider (read-only)</p>
                  <div className="grid grid-cols-2 gap-y-1 text-xs">
                    <span className="text-[var(--subtle)]">Payout wallet C</span>
                    <span className={`mono ${PROVIDER_PAYOUT === "0x0000000000000000000000000000000000000000" ? "text-[var(--danger)]" : "text-[var(--muted)]"}`}>
                      {PROVIDER_PAYOUT === "0x0000000000000000000000000000000000000000"
                        ? "NOT CONFIGURED"
                        : formatAddr(PROVIDER_PAYOUT)}
                    </span>
                    <span className="text-[var(--subtle)]">Quote signer D</span>
                    <span className={`mono ${QUOTE_SIGNER === "0x0000000000000000000000000000000000000000" ? "text-[var(--danger)]" : "text-[var(--muted)]"}`}>
                      {QUOTE_SIGNER === "0x0000000000000000000000000000000000000000"
                        ? "NOT CONFIGURED"
                        : formatAddr(QUOTE_SIGNER)}
                    </span>
                    <span className="text-[var(--subtle)]">Fixed price</span>
                    <span className="font-medium text-[var(--ink-2)]">$0.05 / call</span>
                  </div>
                  <p className="text-xs text-[var(--subtle)] mt-1">
                    Provider addresses are locked at session creation and immutable thereafter.
                  </p>
                </div>

                {/* Budget fields */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-[var(--ink-2)] mb-1.5" htmlFor="maxBudget">
                      Max budget (USDC) <span className="text-[var(--danger)]">*</span>
                    </label>
                    <input
                      id="maxBudget"
                      type="text" inputMode="decimal"
                      value={form.maxBudget}
                      onChange={e => setForm(f => ({ ...f, maxBudget: e.target.value }))}
                      className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]
                                 px-3 py-2.5 text-sm tabular text-[var(--ink)]
                                 focus:outline-none focus:ring-2 focus:ring-[var(--focus)]"
                    />
                    {formErrors.maxBudget && (
                      <p className="text-xs text-[var(--danger)] mt-1">{formErrors.maxBudget}</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-[var(--ink-2)] mb-1.5" htmlFor="cap">
                      Per-call cap (USDC) <span className="text-[var(--danger)]">*</span>
                    </label>
                    <input
                      id="cap"
                      type="text" inputMode="decimal"
                      value={form.perPaymentCap}
                      onChange={e => setForm(f => ({ ...f, perPaymentCap: e.target.value }))}
                      className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]
                                 px-3 py-2.5 text-sm tabular text-[var(--ink)]
                                 focus:outline-none focus:ring-2 focus:ring-[var(--focus)]"
                    />
                    {formErrors.perPaymentCap && (
                      <p className="text-xs text-[var(--danger)] mt-1">{formErrors.perPaymentCap}</p>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-[var(--ink-2)] mb-1.5" htmlFor="expiry">
                      Expiry (days) <span className="text-[var(--danger)]">*</span>
                    </label>
                    <input
                      id="expiry"
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={form.expiryDays}
                      onChange={e => setForm(f => ({ ...f, expiryDays: e.target.value.replace(/[^0-9]/g, "") }))}
                      className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]
                                 px-3 py-2.5 text-sm tabular text-[var(--ink)]
                                 focus:outline-none focus:ring-2 focus:ring-[var(--focus)]"
                    />
                    {formErrors.expiryDays && (
                      <p className="text-xs text-[var(--danger)] mt-1">{formErrors.expiryDays}</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-[var(--ink-2)] mb-1.5" htmlFor="fund">
                      Initial funding (USDC)
                    </label>
                    <input
                      id="fund"
                      type="text" inputMode="decimal"
                      value={form.fundAmount}
                      onChange={e => setForm(f => ({ ...f, fundAmount: e.target.value }))}
                      className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]
                                 px-3 py-2.5 text-sm tabular text-[var(--ink)]
                                 focus:outline-none focus:ring-2 focus:ring-[var(--focus)]"
                    />
                    {formErrors.fundAmount && (
                      <p className="text-xs text-[var(--danger)] mt-1">{formErrors.fundAmount}</p>
                    )}
                  </div>
                </div>

                {/* Spending summary */}
                <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 space-y-1 text-xs">
                  <p className="font-semibold text-[var(--ink-2)]">Spending summary</p>
                  {(() => {
                    const b = parseUsdcUnits(form.maxBudget) ?? 0n;
                    const c = parseUsdcUnits(form.perPaymentCap) ?? 0n;
                    const f = parseUsdcUnits(form.fundAmount) ?? 0n;
                    const maxCalls = c > 0n ? b / c : 0n;
                    // V2 gross for the current per-call cap
                    const { grossAmount: grossCap, feeAmount: feeCap } = c > 0n ? computeFeeV2(c) : { grossAmount: 0n, feeAmount: 0n };
                    return (
                      <>
                        <p className="text-[var(--muted)]">
                          Max budget ceiling: <strong>{formatUsdcShort(b)}</strong> — agent cannot exceed this lifetime total
                        </p>
                        <p className="text-[var(--muted)]">
                          Initial deposit: <strong>{formatUsdcShort(f)}</strong> — what you actually transfer now (step 3)
                        </p>
                        <p className="text-[var(--muted)]">
                          Per-call cap: {formatUsdcShort(c)} × up to {maxCalls.toString()} calls (V1, no fee)
                        </p>
                        {V2_CONFIGURED && c > 0n && (
                          <p className="text-[var(--muted)]">
                            If used with V2: per-call gross = {formatUsdcShort(grossCap)}
                            {" "}({formatUsdcShort(c)} base + {formatUsdcShort(feeCap)} platform fee).
                            Per-call cap must be &gt;= gross.
                          </p>
                        )}
                        <p className="text-[var(--subtle)] pt-1 border-t border-[var(--border)]">
                          Max budget and cap are gross-inclusive in V2 (covers base + fee).
                          Only deposited funds can be spent. Owner can close and recover any unspent deposit at any time.
                        </p>
                      </>
                    );
                  })()}
                </div>

                <button
                  onClick={handleCreate}
                  disabled={isCreating || !PROVIDER_CONFIGURED}
                  className="w-full rounded-xl bg-[var(--accent)] text-[#0d1b2f] py-3 font-semibold
                             hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
                >
                  {isCreating ? "Simulating…" : PROVIDER_CONFIGURED ? "Create session" : "Provider not configured"}
                </button>
              </div>
            )}

            {/* Progress stepper — shown after form submission */}
            {flow.step !== "form" && (
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 space-y-5">
                <div className="flex items-center justify-between">
                  <h2 className="display font-semibold text-base text-[var(--ink-2)]">Transaction progress</h2>
                  {(flow.createStatus === "failed" || flow.createStatus === "cancelled") && (
                    <button
                      onClick={resetFlow}
                      className="text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
                    >
                      Start over
                    </button>
                  )}
                </div>
                <TransactionStepper steps={steps} />

                {/* Step 1 success → show Approve button */}
                {flow.step === "created" && flow.sessionId != null && (
                  <div className="space-y-3">
                    <div className="rounded-xl bg-[rgba(141,216,159,0.08)] border border-[rgba(141,216,159,0.2)] px-4 py-3">
                      <p className="text-sm font-semibold text-[var(--success)]">
                        Session #{flow.sessionId.toString()} created
                      </p>
                      {flow.createHash && <TxLink hash={flow.createHash} className="mt-1" label="View create tx" />}
                    </div>
                    <button
                      onClick={handleApprove}
                      disabled={isApproving}
                      className="w-full rounded-xl bg-[var(--accent)] text-[#0d1b2f] py-3 font-semibold
                                 hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
                    >
                      {isApproving
                        ? txStatusLabel(flow.approveStatus, "Approve USDC")
                        : `Approve ${formatUsdcShort(parseUsdcUnits(form.fundAmount) ?? 0n)} USDC`}
                    </button>
                    <p className="text-xs text-[var(--subtle)]">
                      Approves only the exact funding amount — not an unlimited allowance.
                    </p>
                  </div>
                )}

                {/* Approve failed → retry */}
                {(flow.approveStatus === "failed" || flow.approveStatus === "cancelled") && flow.step === "created" && (
                  <button
                    onClick={handleApprove}
                    className="w-full rounded-xl bg-[var(--surface-strong)] border border-[var(--border)]
                               text-[var(--ink-2)] py-3 font-semibold hover:bg-[var(--surface-muted)] transition-colors"
                  >
                    Retry USDC Approval
                  </button>
                )}

                {/* Step 2 success → Fund button */}
                {flow.step === "approved" && (
                  <div className="space-y-3">
                    <div className="rounded-xl bg-[rgba(141,216,159,0.08)] border border-[rgba(141,216,159,0.2)] px-4 py-3">
                      <p className="text-sm font-semibold text-[var(--success)]">USDC approved</p>
                      {flow.approveHash && <TxLink hash={flow.approveHash} className="mt-1" label="View approval tx" />}
                    </div>
                    <button
                      onClick={handleFund}
                      disabled={isFunding}
                      className="w-full rounded-xl bg-[var(--accent)] text-[#0d1b2f] py-3 font-semibold
                                 hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
                    >
                      {isFunding
                        ? txStatusLabel(flow.fundStatus, "Fund Session")
                        : `Fund session with ${formatUsdcShort(parseUsdcUnits(form.fundAmount) ?? 0n)}`}
                    </button>
                  </div>
                )}

                {/* Fund failed → retry */}
                {(flow.fundStatus === "failed" || flow.fundStatus === "cancelled") && flow.step === "approved" && (
                  <button
                    onClick={handleFund}
                    className="w-full rounded-xl bg-[var(--surface-strong)] border border-[var(--border)]
                               text-[var(--ink-2)] py-3 font-semibold hover:bg-[var(--surface-muted)] transition-colors"
                  >
                    Retry Fund Session
                  </button>
                )}

                {/* In-flight status messages */}
                {(isCreating || isApproving || isFunding) && (
                  <p className="text-sm text-[var(--muted)] animate-pulse">
                    {isCreating  ? txStatusLabel(flow.createStatus,  "Creating session…")
                    : isApproving ? txStatusLabel(flow.approveStatus, "Approving USDC…")
                    :               txStatusLabel(flow.fundStatus,    "Funding session…")}
                  </p>
                )}

                {/* Done */}
                {flow.step === "done" && flow.sessionId != null && (
                  <div className="space-y-3">
                    <div className="rounded-xl bg-[rgba(141,216,159,0.08)] border border-[rgba(141,216,159,0.2)] px-4 py-3">
                      <p className="text-sm font-semibold text-[var(--success)]">
                        Session #{flow.sessionId.toString()} is live and funded!
                      </p>
                      {flow.fundHash && <TxLink hash={flow.fundHash} className="mt-1" label="View fund tx" />}
                    </div>
                    <button
                      onClick={() => { void navigate(`/sessions/${flow.sessionId}`); }}
                      className="w-full rounded-xl bg-[var(--surface-strong)] border border-[var(--border)]
                                 text-[var(--ink-2)] py-3 font-semibold hover:bg-[var(--surface-muted)] transition-colors"
                    >
                      View session →
                    </button>
                  </div>
                )}

                {/* Recovery notice — shown after refresh if prior step succeeded */}
                {(flow.createStatus === "confirmed" && flow.step === "created") && (
                  <p className="text-xs text-[var(--subtle)]">
                    Resumed from previous session. Complete the approval and funding steps below.
                  </p>
                )}
                {(flow.approveStatus === "confirmed" && flow.step === "approved") && (
                  <p className="text-xs text-[var(--subtle)]">
                    Resumed from previous approval. Complete the funding step below.
                  </p>
                )}
              </div>
            )}

            {/* Contract address confirmation */}
            <div className="text-xs text-[var(--subtle)] text-center">
              Contract: <span className="mono">{BUDGET_RAIL_ADDRESS}</span>
              {" · "}{ARC.chainName} chain {CHAIN_ID}
            </div>
          </>
        )}
      </NetworkGuard>

      {/* Confirm modal */}
      {showConfirm && (
        <ConfirmModal
          title="Create payment session?"
          body={
            <div className="space-y-2 text-sm">
              {/* Owner row — explicitly shown so there is no ambiguity about who signs */}
              <div className="rounded-lg bg-[rgba(66,184,224,0.08)] border border-[rgba(66,184,224,0.2)] px-3 py-2">
                <p className="text-xs font-semibold text-[var(--accent)] mb-0.5">Connected owner A — this wallet signs the transaction</p>
                <p className="mono text-xs text-[var(--ink)]">{address}</p>
                <p className="text-xs text-[var(--subtle)] mt-0.5">
                  Chain: Arc Testnet ({CHAIN_ID}) · Contract: {formatAddr(BUDGET_RAIL_ADDRESS)}
                </p>
              </div>
              <p><strong>Agent B (authorized payer):</strong> <span className="mono">{form.agentAddress}</span></p>
              <p><strong>Provider payout C:</strong> <span className="mono">{formatAddr(PROVIDER_PAYOUT)}</span>
                <span className="text-xs text-[var(--subtle)] ml-1">— service revenue, NOT connected wallet</span>
              </p>
              <p><strong>Quote signer D:</strong> <span className="mono">{formatAddr(QUOTE_SIGNER)}</span>
                <span className="text-xs text-[var(--subtle)] ml-1">— backend signing key, NOT connected wallet</span>
              </p>
              <p><strong>Max budget:</strong> {formatUsdcShort(parseUsdcUnits(form.maxBudget) ?? 0n)}</p>
              <p><strong>Per-call cap:</strong> {formatUsdcShort(parseUsdcUnits(form.perPaymentCap) ?? 0n)}</p>
              <p><strong>Expires:</strong> {form.expiryDays} days from now</p>
              <p><strong>Initial funding:</strong> {formatUsdcShort(parseUsdcUnits(form.fundAmount) ?? 0n)}</p>
              <div className="rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-xs text-[var(--subtle)] mt-2 space-y-1">
                <p>A simulation runs first — your wallet only opens if simulation passes.</p>
                <p>Provider C and quote signer D are immutable once the session is created.</p>
                <p>Owner A cannot be changed after creation.</p>
              </div>
            </div>
          }
          confirmLabel="Simulate & Create"
          onConfirm={onConfirmCreate}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </div>
  );
}
