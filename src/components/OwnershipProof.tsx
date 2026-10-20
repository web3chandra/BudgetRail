/**
 * OwnershipProof — optional wallet ownership verification via sign-a-nonce.
 *
 * Allows the operator (or any user) to prove they control a given address C or D
 * by signing a deterministic nonce message with the connected wallet.
 * The component verifies the signature locally (ecrecover via viem) without
 * sending anything to an external server.
 *
 * Rules:
 * - Read-only to the chain: no transactions, no approvals, no ETH/USDC transfer.
 * - No private key or seed phrase input — only the connected wallet signs.
 * - Signatures are NOT sent to any external domain.
 * - The nonce is derived from the address being proved + timestamp, so it cannot
 *   be replayed for a different address.
 * - Result is in-memory only; nothing is persisted to localStorage or backend.
 */
import { useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { verifyMessage } from "viem";
import { ShieldCheck, ShieldAlert, Info } from "lucide-react";
import { formatAddr } from "@/lib/format";

// ── Types ──────────────────────────────────────────────────────────────────

export type ProofStatus = "idle" | "signing" | "verified" | "failed" | "wrong_wallet";

export interface OwnershipProofResult {
  status:          ProofStatus;
  claimedAddress:  string;
  provenAddress?:  string;
  error?:          string;
}

export interface OwnershipProofProps {
  /** The address whose ownership should be proved (e.g. C or D). */
  claimAddress: `0x${string}`;
  /** Human label for display, e.g. "Provider payout C" or "Quote signer D". */
  roleLabel: string;
  /** Callback with the proof result. */
  onResult?: (result: OwnershipProofResult) => void;
  className?: string;
}

// ── Nonce generation ───────────────────────────────────────────────────────

/**
 * Build a deterministic human-readable message for the ownership proof.
 * Includes a timestamp-derived nonce so the message cannot be replayed for
 * a different proof attempt at a different time.
 */
function buildProofMessage(address: string, roleLabel: string): string {
  // Round to nearest 5-minute window so a page reload within 5 min gives the same message
  const window = Math.floor(Date.now() / 300_000);
  return [
    "BudgetRail Ownership Proof",
    `Role: ${roleLabel}`,
    `Address: ${address.toLowerCase()}`,
    `Window: ${window}`,
    "I confirm I control this address. This signature is for local verification only.",
    "It is not sent to any server and involves no transaction or fund transfer.",
  ].join("\n");
}

// ── Component ──────────────────────────────────────────────────────────────

export function OwnershipProof({ claimAddress, roleLabel, onResult, className = "" }: OwnershipProofProps) {
  const { address: connectedAddress, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const [status, setStatus] = useState<ProofStatus>("idle");
  const [provenAddress, setProvenAddress] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const ZERO = "0x0000000000000000000000000000000000000000";
  const isZeroClaim = !claimAddress || claimAddress === ZERO;

  async function handleProve() {
    if (!isConnected || !connectedAddress) return;
    if (isZeroClaim) return;

    setStatus("signing");
    setError(undefined);
    setProvenAddress(undefined);

    const message = buildProofMessage(claimAddress, roleLabel);

    try {
      const signature = await signMessageAsync({ message });

      // Recover signer locally — no network call
      const recovered = await verifyMessage({ address: claimAddress, message, signature })
        .then(valid => valid ? claimAddress : null)
        .catch(() => null);

      if (recovered) {
        setStatus("verified");
        setProvenAddress(claimAddress);
        onResult?.({
          status:         "verified",
          claimedAddress: claimAddress,
          provenAddress:  claimAddress,
        });
      } else {
        // Signature was valid but recovered address doesn't match — wrong wallet connected
        setStatus("wrong_wallet");
        setError(
          `Signature recovered to a different address. ` +
          `Switch to the wallet controlling ${formatAddr(claimAddress)} and try again.`
        );
        onResult?.({
          status:         "wrong_wallet",
          claimedAddress: claimAddress,
          error:          "Recovered address does not match claimed address",
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("user rejected") || msg.toLowerCase().includes("denied")) {
        setStatus("idle");
        return;
      }
      setStatus("failed");
      setError(msg.length > 120 ? msg.slice(0, 120) + "…" : msg);
      onResult?.({ status: "failed", claimedAddress: claimAddress, error: msg });
    }
  }

  function reset() {
    setStatus("idle");
    setError(undefined);
    setProvenAddress(undefined);
  }

  if (isZeroClaim) {
    return (
      <div className={`flex items-start gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 ${className}`}>
        <Info size={12} className="shrink-0 text-[var(--subtle)] mt-0.5" />
        <p className="text-[11px] text-[var(--subtle)]">
          {roleLabel} address is not configured — cannot verify ownership.
        </p>
      </div>
    );
  }

  return (
    <div className={`rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 space-y-2 ${className}`}>
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {status === "verified" ? (
            <ShieldCheck size={13} className="text-[var(--success)]" />
          ) : status === "wrong_wallet" || status === "failed" ? (
            <ShieldAlert size={13} className="text-[var(--danger)]" />
          ) : (
            <ShieldAlert size={13} className="text-[var(--subtle)]" />
          )}
          <span className="text-xs font-semibold text-[var(--ink-2)]">{roleLabel} — ownership proof</span>
        </div>

        {/* Status pill */}
        {status === "verified" && (
          <span className="text-[10px] px-1.5 py-px rounded-full bg-[rgba(141,216,159,0.15)] text-[var(--success)] font-medium">
            verified
          </span>
        )}
        {(status === "idle" || status === "wrong_wallet" || status === "failed") && (
          <span className="text-[10px] px-1.5 py-px rounded-full bg-[rgba(148,163,184,0.12)] text-[var(--subtle)] font-medium">
            unverified
          </span>
        )}
      </div>

      {/* Address being proved */}
      <p className="text-[11px] text-[var(--subtle)]">
        Proving: <span className="mono text-[var(--ink-2)]">{claimAddress}</span>
      </p>

      {/* Result or instruction */}
      {status === "verified" && (
        <div className="flex items-start gap-1.5 rounded-lg bg-[rgba(141,216,159,0.08)] border border-[rgba(141,216,159,0.2)] px-2.5 py-2">
          <ShieldCheck size={11} className="shrink-0 text-[var(--success)] mt-0.5" />
          <p className="text-[11px] text-[var(--muted)]">
            Ownership confirmed: connected wallet controls{" "}
            <span className="mono">{formatAddr(provenAddress ?? "")}</span>.
            Proof is in-memory only — no transaction was broadcast.
          </p>
        </div>
      )}

      {(status === "wrong_wallet" || status === "failed") && error && (
        <div className="flex items-start gap-1.5 rounded-lg bg-[rgba(232,109,122,0.06)] border border-[rgba(232,109,122,0.2)] px-2.5 py-2">
          <ShieldAlert size={11} className="shrink-0 text-[var(--danger)] mt-0.5" />
          <p className="text-[11px] text-[var(--muted)]">{error}</p>
        </div>
      )}

      {status === "idle" && (
        <p className="text-[11px] text-[var(--subtle)] leading-relaxed text-pretty">
          Connect the wallet controlling this address and click Verify. A human-readable message
          will be signed locally — no transaction, no gas, no external server.
        </p>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        {status !== "verified" && (
          <button
            onClick={() => { void handleProve(); }}
            disabled={!isConnected || status === "signing"}
            className="flex-1 rounded-lg bg-[var(--surface-strong)] border border-[var(--border)]
                       px-3 py-1.5 text-xs font-semibold text-[var(--ink-2)]
                       hover:bg-[var(--surface)] disabled:opacity-50 disabled:cursor-not-allowed
                       transition-colors"
          >
            {status === "signing" ? "Sign in wallet…" : !isConnected ? "Connect wallet first" : "Verify ownership"}
          </button>
        )}
        {status === "verified" && (
          <button
            onClick={reset}
            className="text-xs text-[var(--subtle)] hover:text-[var(--muted)] transition-colors"
          >
            Reset
          </button>
        )}
      </div>

      {/* Disclosure */}
      <p className="text-[10px] text-[var(--subtle)] leading-relaxed">
        This only proves you control the address right now. It does not transfer any authority
        on-chain, does not update the session, and does not affect payments.
      </p>
    </div>
  );
}
