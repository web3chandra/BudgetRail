/**
 * WalletRolePanel — "Who gets paid?" information panel.
 *
 * Displays every BudgetRail role with full copyable addresses, chain/contract
 * context, explorer links, proven source labels, and permission notes.
 *
 * Roles:
 *   A = Owner     — connected wallet; creates/funds/closes; receives refund
 *   B = Agent     — executes provider-approved payments; set at creation
 *   C = Provider  — receives 100% of quoted base price; NOT operator profit in
 *                   a multi-provider system; may be any registered provider
 *   D = Signer    — signs quotes, never receives USDC; rotating D requires
 *                   new sessions; old sessions keep their old D permanently
 *   V = Vault     — this contract; routes payments; never withdrawable by deployer
 *   E = Treasury  — V2 only; receives the 0.5% platform surcharge per payment
 *
 * Data sources are explicit: "connected wallet", "session chain state",
 * "backend public config", "deployment metadata". Ownership is NOT inferred from
 * an address in .env — we show "unverified" unless the user proves it via
 * OwnershipProof.
 *
 * This component is read-only. It never signs or broadcasts.
 */
import { useState } from "react";
import { Copy, Check, ExternalLink, Info, AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { ARC, PROVIDER_CONFIGURED } from "@/lib/arcProfile";
import { formatAddr } from "@/lib/format";
import { buildAddressExplorerUrl } from "@/onchain-facts";
import type { SessionTuple } from "@/lib/budgetRail";

// ── Types ──────────────────────────────────────────────────────────────────

export type ContractVersion = "V1" | "V2";

export interface WalletRolePanelProps {
  /** Connected wallet A address. Undefined when disconnected. */
  ownerAddress?: `0x${string}`;
  /** Agent wallet B. Undefined before session creation (form stage). */
  agentAddress?: `0x${string}`;
  /**
   * Loaded session data for an existing session. When provided, C/D come from
   * immutable chain state instead of backend config. If absent, C/D come from
   * backend env vars (pre-creation preview).
   */
  session?: SessionTuple;
  /** V1 = current contract. V2 = future separate deployment. */
  contractVersion?: ContractVersion;
  /** Whether to show the full panel or a collapsed summary. */
  collapsed?: boolean;
  /** Additional className for the outer container. */
  className?: string;
}

interface RoleRowProps {
  role:        string;
  roleLabel:   string;
  address:     string | undefined;
  source:      string;
  permission:  string;
  warning?:    string;
  isZero?:     boolean;
  isCurrentWallet?: boolean;
}

// ── CopyButton ─────────────────────────────────────────────────────────────

function CopyButton({ value, className = "" }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <button
      onClick={handleCopy}
      aria-label={copied ? "Copied" : "Copy address"}
      title={copied ? "Copied!" : "Copy full address"}
      className={`p-0.5 rounded text-[var(--subtle)] hover:text-[var(--ink)] transition-colors ${className}`}
    >
      {copied ? <Check size={11} strokeWidth={2.5} /> : <Copy size={11} />}
    </button>
  );
}

// ── AddressCell ────────────────────────────────────────────────────────────

function AddressCell({
  address,
  isZero = false,
  isCurrentWallet = false,
}: {
  address: string | undefined;
  isZero?: boolean;
  isCurrentWallet?: boolean;
}) {
  if (!address || address === "" || address === "0x") {
    return <span className="text-[var(--subtle)] text-xs italic">not set</span>;
  }
  const explorerUrl = buildAddressExplorerUrl(ARC.chainId, address);

  return (
    <span className="inline-flex items-center gap-1 min-w-0">
      <span className={`mono text-xs ${isZero ? "text-[var(--danger)]" : isCurrentWallet ? "text-[var(--success)]" : "text-[var(--ink-2)]"}`}>
        {formatAddr(address)}
      </span>
      <CopyButton value={address} />
      <a
        href={explorerUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="View on explorer"
        className="text-[var(--subtle)] hover:text-[var(--accent)] transition-colors"
      >
        <ExternalLink size={10} />
      </a>
    </span>
  );
}

// ── RoleRow ────────────────────────────────────────────────────────────────

function RoleRow({
  role, roleLabel, address, source, permission, warning, isZero, isCurrentWallet,
}: RoleRowProps) {
  const ZERO = "0x0000000000000000000000000000000000000000";
  const isActuallyZero = isZero ?? (!!address && address === ZERO);

  return (
    <div className="py-2.5 border-b border-[var(--border)] last:border-0">
      <div className="flex items-start gap-3">
        {/* Role badge */}
        <span className="shrink-0 w-6 h-6 rounded-full bg-[var(--surface-strong)] border border-[var(--border)]
                         flex items-center justify-center text-[10px] font-bold text-[var(--ink-2)] mt-0.5 tabular">
          {role}
        </span>

        {/* Main content */}
        <div className="flex-1 min-w-0 space-y-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-[var(--ink-2)]">{roleLabel}</span>
            {isCurrentWallet && (
              <span className="text-[10px] font-medium px-1.5 py-px rounded-full
                               bg-[rgba(141,216,159,0.15)] text-[var(--success)]">
                connected wallet
              </span>
            )}
            {isActuallyZero && (
              <span className="text-[10px] font-medium px-1.5 py-px rounded-full
                               bg-[rgba(232,109,122,0.12)] text-[var(--danger)]">
                NOT CONFIGURED
              </span>
            )}
          </div>

          <AddressCell address={address} isZero={isActuallyZero} isCurrentWallet={isCurrentWallet} />

          <p className="text-[11px] text-[var(--subtle)] leading-tight">
            <span className="font-medium text-[var(--muted)]">Source:</span> {source}
          </p>
          <p className="text-[11px] text-[var(--subtle)] leading-tight text-pretty">
            {permission}
          </p>
        </div>
      </div>

      {warning && (
        <div className="mt-2 ml-9 flex items-start gap-1.5 rounded-lg bg-amber-500/8 border border-amber-500/30 px-2.5 py-1.5">
          <AlertTriangle size={11} className="shrink-0 text-amber-400 mt-0.5" />
          <p className="text-[11px] text-amber-200/80 text-pretty leading-tight">{warning}</p>
        </div>
      )}
    </div>
  );
}

// ── SignerRotationRunbook ──────────────────────────────────────────────────

function SignerRotationRunbook() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left
                   hover:bg-[var(--surface-strong)] transition-colors"
      >
        <span className="text-xs font-semibold text-[var(--ink-2)]">Quote signer D — rotation runbook</span>
        {open ? <ChevronDown size={13} className="text-[var(--subtle)]" /> : <ChevronRight size={13} className="text-[var(--subtle)]" />}
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 space-y-2 border-t border-[var(--border)]">
          <p className="text-[11px] text-[var(--muted)] leading-relaxed text-pretty">
            The quote signer D address is frozen permanently into each session at creation time.
            Rotating the backend key (<code className="mono text-[10px]">QUOTE_SIGNER_PRIVATE_KEY</code>) changes
            the public address D exposed in <code className="mono text-[10px]">VITE_QUOTE_SIGNER</code>,
            which affects new sessions only. Existing sessions with the old D address will no longer receive
            valid quotes from the new key.
          </p>
          <p className="text-[11px] font-semibold text-amber-300">Safe rotation procedure:</p>
          <ol className="list-decimal list-inside space-y-1 text-[11px] text-[var(--muted)] leading-relaxed">
            <li>Let the current session reach a natural end (all work done, no pending payments).</li>
            <li>Owner A calls Close &amp; Refund on all open sessions tied to the old D.</li>
            <li>Deploy the new private key to the backend <code className="mono text-[10px]">provider/.env</code>. Restart the provider.</li>
            <li>Update <code className="mono text-[10px]">VITE_QUOTE_SIGNER</code> in the frontend <code className="mono text-[10px]">.env</code>. Rebuild and redeploy the frontend.</li>
            <li>Owner A creates new sessions — they will have the new D address locked in on-chain.</li>
          </ol>
          <p className="text-[11px] text-[var(--subtle)]">
            Never update an existing session's <code className="mono text-[10px]">quoteSigner</code> field — the contract provides no such function and the field is intentionally immutable.
          </p>
        </div>
      )}
    </div>
  );
}

// ── E Treasury note (V2 only) ──────────────────────────────────────────────

function TreasuryNote({ version }: { version: ContractVersion }) {
  if (version === "V1") {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5">
        <Info size={12} className="shrink-0 text-[var(--subtle)] mt-0.5" />
        <p className="text-[11px] text-[var(--subtle)] leading-relaxed text-pretty">
          <strong>E (Treasury):</strong> not present in V1. V1 routes 100% of every payment to provider C.
          A separate 0.5% platform fee (role E) is planned for a future V2 contract deployed at a new address.
          V1 sessions will never pay a treasury fee.
        </p>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
      <Info size={12} className="shrink-0 text-amber-400 mt-0.5" />
      <p className="text-[11px] text-amber-200/70 leading-relaxed text-pretty">
        <strong>E (Treasury):</strong> receives exactly 0.5% of every V2 payment gross at settlement time, automatically.
        The treasury owner spends this USDC using their own wallet with sufficient gas.
        There is no admin-withdraw function — the contract sends E's share directly on each successful payment.
        Deposits and refunds are NOT earnings and never route to E.
      </p>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function WalletRolePanel({
  ownerAddress,
  agentAddress,
  session,
  contractVersion = "V1",
  collapsed: initialCollapsed = false,
  className = "",
}: WalletRolePanelProps) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;

  // C (provider payout) and D (quote signer) come from:
  //   - session chain state when a session is loaded (immutable, proven source)
  //   - backend public config (ARC.providerPayout / ARC.quoteSigner) before session exists
  const providerAddress = session ? session.provider    : ARC.providerPayout;
  const signerAddress   = session ? session.quoteSigner : ARC.quoteSigner;
  const agentAddr       = session ? session.agent       : agentAddress;
  const ownerAddr       = session ? session.owner       : ownerAddress;

  const providerSource = session
    ? "session chain state (immutable — set at creation, onchain)"
    : "backend public config (VITE_PROVIDER_PAYOUT — before session creation)";
  const signerSource = session
    ? "session chain state (immutable — set at creation, onchain)"
    : "backend public config (VITE_QUOTE_SIGNER — before session creation)";

  const ownerIsAgent = !!(ownerAddr && agentAddr &&
    ownerAddr.toLowerCase() === agentAddr.toLowerCase());

  const signerMismatch = !!(session &&
    ARC.quoteSigner !== ZERO &&
    session.quoteSigner.toLowerCase() !== ARC.quoteSigner.toLowerCase());

  const isProviderZero = providerAddress === ZERO;
  const isSignerZero   = signerAddress   === ZERO;

  return (
    <div className={`rounded-2xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden ${className}`}>
      {/* Header */}
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-[var(--surface-strong)] transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--ink-2)]">Who gets paid?</span>
          <span className="text-[10px] px-1.5 py-px rounded-full bg-[var(--surface-strong)]
                           text-[var(--subtle)] font-medium uppercase tracking-wider">
            {contractVersion}
          </span>
          {(isProviderZero || isSignerZero || !PROVIDER_CONFIGURED) && (
            <span className="text-[10px] px-1.5 py-px rounded-full bg-[rgba(232,109,122,0.12)]
                             text-[var(--danger)] font-medium">
              config missing
            </span>
          )}
        </div>
        {collapsed
          ? <ChevronRight size={14} className="text-[var(--subtle)]" />
          : <ChevronDown  size={14} className="text-[var(--subtle)]" />}
      </button>

      {!collapsed && (
        <div className="px-5 pb-5 space-y-3 border-t border-[var(--border)]">

          {/* Chain + contract context */}
          <div className="pt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
            <span className="text-[var(--subtle)]">Chain</span>
            <span className="font-medium text-[var(--ink-2)]">{ARC.chainName} ({ARC.chainId})</span>
            <span className="text-[var(--subtle)]">Contract ({contractVersion})</span>
            <span className="inline-flex items-center gap-1">
              <span className="mono text-[var(--ink-2)]">{formatAddr(ARC.contractAddress)}</span>
              <CopyButton value={ARC.contractAddress} />
              <a
                href={buildAddressExplorerUrl(ARC.chainId, ARC.contractAddress)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--subtle)] hover:text-[var(--accent)] transition-colors"
              >
                <ExternalLink size={10} />
              </a>
            </span>
          </div>

          {/* Role rows */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 divide-y divide-[var(--border)]">
            <RoleRow
              role="A"
              roleLabel="Owner (you)"
              address={ownerAddr}
              source={ownerAddr ? "connected wallet — proven by wallet signature" : "not connected"}
              permission="Creates sessions, funds them, adds top-ups, closes and recovers unspent USDC. Cannot touch agent-spendable funds mid-session."
              isCurrentWallet={!!(ownerAddr && ownerAddress && ownerAddr.toLowerCase() === ownerAddress.toLowerCase())}
            />
            <RoleRow
              role="B"
              roleLabel="Agent"
              address={agentAddr}
              source={session ? "session chain state (immutable)" : "entered by owner at creation"}
              permission="Can execute provider-approved payments up to per-call cap and budget ceiling. Cannot close session or recover funds."
              warning={ownerIsAgent ? "A = B: same-wallet demo mode. Useful for manual testing. In production, use a separate agent wallet." : undefined}
            />
            <RoleRow
              role="C"
              roleLabel="Provider payout"
              address={providerAddress}
              source={providerSource}
              permission={
                contractVersion === "V1"
                  ? "Receives 100% of the provider-quoted base price on every successful payment. This is the provider's revenue, NOT necessarily the BudgetRail operator's profit — any registered provider can occupy this role."
                  : "Receives provider-quoted base price minus the 0.5% platform fee. Provider's revenue only."
              }
              isZero={isProviderZero}
              warning={isProviderZero
                ? "Provider payout address is zero — session creation is blocked until VITE_PROVIDER_PAYOUT is set."
                : "Ownership unverified. The operator or external provider controls this wallet. Use the ownership proof tool below to verify."}
            />
            <RoleRow
              role="D"
              roleLabel="Quote signer"
              address={signerAddress}
              source={signerSource}
              permission="Backend-controlled identity that signs EIP-712 quotes. Never receives USDC. Rotating D requires new sessions — existing sessions with the old D are no longer serviceable by the new backend key."
              isZero={isSignerZero}
              warning={signerMismatch
                ? `Signer mismatch: this session uses ${formatAddr(session.quoteSigner)}, but the current backend key is ${formatAddr(ARC.quoteSigner)}. Quotes will be rejected. See rotation runbook below.`
                : isSignerZero
                  ? "Quote signer address is zero — session creation is blocked until VITE_QUOTE_SIGNER is set."
                  : undefined}
            />
            <RoleRow
              role="V"
              roleLabel="Contract vault"
              address={ARC.contractAddress}
              source="deployment metadata (VITE_BUDGET_RAIL_ADDRESS)"
              permission="Holds session balances and routes payments. The deployer wallet has no special authority to withdraw session funds. Only the session owner can recover unspent funds via closeSession."
            />
          </div>

          {/* E Treasury note */}
          <TreasuryNote version={contractVersion} />

          {/* Signer rotation runbook */}
          <SignerRotationRunbook />

          {/* Deployer note */}
          <div className="flex items-start gap-2 text-[11px] text-[var(--subtle)]">
            <Info size={11} className="shrink-0 mt-0.5" />
            <p>
              The deployer wallet paid gas to deploy the contract but has no special on-chain authority.
              It cannot withdraw session funds, change provider addresses, or modify any session after creation.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
