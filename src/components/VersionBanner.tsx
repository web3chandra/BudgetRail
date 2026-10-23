/**
 * VersionBanner — shows chain, contract version, address, deploy block, and explorer link.
 *
 * Displays above any form or session page so the user always knows which
 * contract version and chain they are interacting with.
 *
 * V1: no platform fee (E does not exist).
 * V2: 0.5% platform fee (50 bps) on service purchases only.
 */

import { ExternalLink, ShieldCheck } from "lucide-react";
import { ARC, V2_CONFIGURED } from "@/lib/arcProfile";
import { BUDGET_RAIL_V2_ADDRESS, TREASURY_ADDRESS } from "@/lib/budgetRailV2";
import { BUDGET_RAIL_ADDRESS } from "@/lib/budgetRail";
import { formatAddr } from "@/lib/format";
import { buildAddressExplorerUrl } from "@/onchain-facts";

export type ContractVersion = "V1" | "V2";

interface VersionBannerProps {
  /** Which contract version this page is showing */
  version: ContractVersion;
  /** Optional additional class names */
  className?: string;
}

export function VersionBanner({ version, className = "" }: VersionBannerProps) {
  const isV2 = version === "V2";
  const contractAddress = isV2 ? BUDGET_RAIL_V2_ADDRESS : BUDGET_RAIL_ADDRESS;
  const deployBlock     = isV2 ? ARC.v2DeployBlock      : ARC.deployBlock;
  const explorerUrl     = buildAddressExplorerUrl(ARC.chainId, contractAddress);
  const isZero          = contractAddress === "0x0000000000000000000000000000000000000000";

  return (
    <div className={`rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 ${className}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        {/* Chain badge */}
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold
          ${ARC.network === "mainnet"
            ? "bg-[rgba(232,109,122,0.12)] text-[var(--danger)] border border-[rgba(232,109,122,0.3)]"
            : "bg-[rgba(66,184,224,0.10)] text-[var(--accent)] border border-[rgba(66,184,224,0.25)]"
          }`}>
          {ARC.chainName}
        </span>

        {/* Version badge */}
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold border
          ${isV2
            ? "bg-[rgba(141,216,159,0.10)] text-[var(--success)] border-[rgba(141,216,159,0.3)]"
            : "bg-[var(--surface-muted)] text-[var(--muted)] border-[var(--border)]"
          }`}>
          <ShieldCheck size={10} />
          BudgetRail {version}
        </span>

        {/* V2 fee notice */}
        {isV2 && (
          <span className="text-[var(--muted)]">
            0.5% platform fee on purchases only
          </span>
        )}
        {!isV2 && (
          <span className="text-[var(--subtle)]">No platform fee (V1)</span>
        )}

        {/* Contract address */}
        {isZero ? (
          <span className="text-[var(--danger)] font-semibold">
            {version} contract not deployed yet
          </span>
        ) : (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 mono text-[var(--subtle)] hover:text-[var(--muted)] transition-colors"
          >
            {formatAddr(contractAddress)}
            <ExternalLink size={10} />
          </a>
        )}

        {/* Deploy block */}
        {!isZero && deployBlock > 0n && (
          <span className="text-[var(--subtle)]">
            from block {deployBlock.toLocaleString()}
          </span>
        )}
      </div>

      {/* V2 treasury row */}
      {isV2 && V2_CONFIGURED && (
        <div className="mt-2 pt-2 border-t border-[var(--border)] flex flex-wrap gap-x-3 gap-y-1 text-xs">
          <span className="text-[var(--subtle)]">Platform treasury E:</span>
          <a
            href={buildAddressExplorerUrl(ARC.chainId, TREASURY_ADDRESS)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 mono text-[var(--muted)] hover:text-[var(--ink)] transition-colors"
          >
            {TREASURY_ADDRESS}
            <ExternalLink size={10} />
          </a>
          <span className="text-[var(--subtle)]">
            receives 0.5% fee on each V2 payment — no admin withdraw, fees arrive directly
          </span>
        </div>
      )}

      {/* V2 not yet configured notice */}
      {isV2 && !V2_CONFIGURED && (
        <p className="mt-1.5 text-xs text-amber-300">
          V2 not yet deployed on {ARC.chainName}. Set VITE_BUDGET_RAIL_V2_ADDRESS and VITE_TREASURY_ADDRESS in .env after deploy.
        </p>
      )}
    </div>
  );
}
