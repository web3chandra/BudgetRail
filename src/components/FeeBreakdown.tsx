/**
 * FeeBreakdown — displays a V2 base/fee/gross price breakdown.
 *
 * Usage:
 *   <FeeBreakdown baseAmount={50_000n} />
 *   <FeeBreakdown baseAmount={50_000n} compact />
 *
 * All arithmetic uses bigint — no floats.
 * Zero-fee case is shown explicitly ("$0.000000 fee — rounds to zero for small purchases").
 */

import { computeFeeV2 } from "@/lib/budgetRailV2";
import { formatUsdcShort } from "@/lib/format";
import { TREASURY_ADDRESS } from "@/lib/budgetRailV2";
import { ARC } from "@/lib/arcProfile";
import { buildAddressExplorerUrl } from "@/onchain-facts";
import { ExternalLink, Info } from "lucide-react";
import { formatAddr } from "@/lib/format";

interface FeeBreakdownProps {
  /** Provider base amount in 6-decimal µUSDC */
  baseAmount:   bigint;
  /** Show compact single-line version (for quote previews) */
  compact?:     boolean;
  /** Optional class names */
  className?:   string;
  /** Show treasury address row (default true) */
  showTreasury?: boolean;
}

export function FeeBreakdown({
  baseAmount,
  compact = false,
  className = "",
  showTreasury = true,
}: FeeBreakdownProps) {
  const { feeAmount, grossAmount } = computeFeeV2(baseAmount);
  const isZeroFee = feeAmount === 0n;
  const treasuryExplorerUrl = buildAddressExplorerUrl(ARC.chainId, TREASURY_ADDRESS);

  if (compact) {
    return (
      <span className={`tabular text-xs text-[var(--muted)] ${className}`}>
        {formatUsdcShort(baseAmount)} base + {formatUsdcShort(feeAmount)} fee = {" "}
        <strong className="text-[var(--ink)]">{formatUsdcShort(grossAmount)} gross</strong>
        {isZeroFee && (
          <span className="text-[var(--subtle)]"> (fee rounds to zero)</span>
        )}
      </span>
    );
  }

  return (
    <div className={`rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 space-y-2 text-xs ${className}`}>
      <p className="font-semibold text-[var(--ink-2)] flex items-center gap-1.5">
        <Info size={11} className="text-[var(--accent)]" />
        V2 payment breakdown
      </p>

      <div className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5">
        {/* Base row */}
        <div>
          <p className="text-[var(--subtle)]">Provider base price</p>
          <p className="text-[var(--muted)] mt-0.5">
            Goes to provider wallet C — 100% of this amount
          </p>
        </div>
        <p className="tabular font-semibold text-[var(--ink)] text-right">
          {formatUsdcShort(baseAmount)}
        </p>

        {/* Fee row */}
        <div>
          <p className={isZeroFee ? "text-[var(--subtle)]" : "text-[var(--muted)]"}>
            BudgetRail platform fee (0.5%)
          </p>
          {isZeroFee && (
            <p className="text-[var(--subtle)] mt-0.5">
              Rounds to zero for very small purchases — no hidden minimum fee
            </p>
          )}
          {!isZeroFee && (
            <p className="text-[var(--subtle)] mt-0.5">
              Goes to treasury E — charged only on successful purchases
            </p>
          )}
        </div>
        <p className={`tabular font-semibold text-right ${isZeroFee ? "text-[var(--subtle)]" : "text-[var(--muted)]"}`}>
          {formatUsdcShort(feeAmount)}
        </p>

        {/* Separator */}
        <div className="col-span-2 border-t border-[var(--border)] my-0.5" />

        {/* Gross row */}
        <p className="font-semibold text-[var(--ink-2)]">
          Total charged from session
        </p>
        <p className="tabular font-bold text-[var(--success)] text-right text-sm">
          {formatUsdcShort(grossAmount)}
        </p>
      </div>

      {/* Treasury address */}
      {showTreasury && !isZeroFee && TREASURY_ADDRESS !== "0x0000000000000000000000000000000000000000" && (
        <div className="pt-1.5 border-t border-[var(--border)] flex items-center gap-1.5 text-[var(--subtle)]">
          <span>Treasury E:</span>
          <a
            href={treasuryExplorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 mono hover:text-[var(--muted)] transition-colors"
          >
            {formatAddr(TREASURY_ADDRESS)}
            <ExternalLink size={9} />
          </a>
        </div>
      )}

      {/* Gas notice */}
      <p className="text-[var(--subtle)] italic">
        Gas is paid separately by agent B from their own wallet — not part of the session budget.
      </p>
    </div>
  );
}
