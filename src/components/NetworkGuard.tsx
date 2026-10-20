/**
 * NetworkGuard — blocks children if the connected wallet is on the wrong chain.
 * Shows a "Switch to Arc Testnet" banner instead.
 */
import { useAccount, useSwitchChain } from "wagmi";
import { arcTestnet } from "viem/chains";

const TARGET_CHAIN_ID = arcTestnet.id;

interface NetworkGuardProps {
  children: React.ReactNode;
  /** If true, renders children even on wrong chain (for read-only views) */
  readOnly?: boolean;
}

export function NetworkGuard({ children, readOnly = false }: NetworkGuardProps) {
  const { isConnected, chainId } = useAccount();
  const { switchChain, isPending } = useSwitchChain();

  const isWrong = isConnected && chainId !== TARGET_CHAIN_ID;

  if (isWrong && !readOnly) {
    return (
      <div className="w-full rounded-xl border border-[var(--danger)] bg-[rgba(232,109,122,0.08)] px-5 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-semibold text-[var(--danger)] text-sm">Wrong network</p>
          <p className="text-[var(--muted)] text-xs mt-0.5">
            This app requires Arc Testnet (chain {TARGET_CHAIN_ID}). You are on chain {chainId}.
          </p>
        </div>
        <button
          onClick={() => switchChain({ chainId: TARGET_CHAIN_ID })}
          disabled={isPending}
          className="shrink-0 rounded-lg bg-[var(--danger)] px-4 py-2 text-sm font-semibold text-white
                     hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {isPending ? "Switching..." : "Switch to Arc Testnet"}
        </button>
      </div>
    );
  }

  return <>{children}</>;
}

export function NetworkBadge() {
  const { isConnected, chainId } = useAccount();
  const onArc = chainId === TARGET_CHAIN_ID;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold
        ${onArc && isConnected
          ? "bg-[rgba(141,216,159,0.15)] text-[var(--success)]"
          : "bg-[rgba(148,163,184,0.15)] text-[var(--subtle)]"
        }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${onArc && isConnected ? "bg-[var(--success)]" : "bg-[var(--subtle)]"}`} />
      {isConnected ? (onArc ? "Arc Testnet" : `Chain ${chainId}`) : "Not connected"}
    </span>
  );
}
