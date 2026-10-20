/**
 * Page 4 — Activity History (/payments)
 *
 * Shows ALL four BudgetRail V1 event types:
 *   SessionCreated · SessionFunded · PaymentSettled · SessionClosed
 *
 * Uses historyScanner for:
 *   - Windowed getLogs (≤ 9 999 blocks per call)
 *   - Exponential-backoff retry on RPC errors — never silently skips
 *   - Dedup by chainId + contract + txHash + logIndex
 *   - Explicit coverage metadata (scannedFrom/To, failedRanges, isComplete)
 *   - Cancellable via AbortController
 *   - 5-minute localStorage checkpoint so refresh only re-scans new blocks
 *
 * Tabs:  All · Payments · Deposits · Refunds
 * Table sorts newest-first (reverse block order).
 */
import { useState, useCallback, useRef } from "react";
import {
  RefreshCw, ChevronLeft, ChevronRight, AlertTriangle, CheckCircle2, Clock,
} from "lucide-react";

import { BUDGET_RAIL_ADDRESS, DEPLOY_BLOCK_TESTNET } from "@/lib/budgetRail";
import {
  scanAllEvents, scanRecentEvents, filterByTab, eventTypeLabel, eventTypeColor,
  saveCheckpoint, loadCheckpoint, clearCheckpoint,
  type ActivityEvent, type ActivityEventTab, type CoverageResult, type ScanProgress,
} from "@/lib/historyScanner";
import { formatUsdcShort } from "@/lib/format";
import { TxLink, AddrLink } from "@/components/ExplorerLink";
import { ErrorBanner, EmptyState, Skeleton } from "@/components/shared";
import { arcTestnet } from "viem/chains";

const CHAIN_ID  = arcTestnet.id;
const PAGE_SIZE = 20;

// ── Tab bar ───────────────────────────────────────────────────────────────────

const TABS: { id: ActivityEventTab; label: string }[] = [
  { id: "all",      label: "All activity" },
  { id: "payments", label: "Payments"     },
  { id: "deposits", label: "Deposits"     },
  { id: "refunds",  label: "Refunds"      },
];

// ── Coverage status badge ────────────────────────────────────────────────────

function CoverageBadge({ result }: { result: CoverageResult }) {
  if (result.isComplete) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-[var(--success)]">
        <CheckCircle2 size={12} />
        Full history (blocks {DEPLOY_BLOCK_TESTNET.toLocaleString()} – {result.scannedTo.toLocaleString()})
      </span>
    );
  }
  if (result.failedRanges.length > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-[var(--danger)]">
        <AlertTriangle size={12} />
        {result.failedRanges.length} window{result.failedRanges.length > 1 ? "s" : ""} failed — history may be incomplete
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-[var(--subtle)]">
      <Clock size={12} />
      Partial: blocks {result.scannedFrom.toLocaleString()} – {result.scannedTo.toLocaleString()}.
      Deploy block is {DEPLOY_BLOCK_TESTNET.toLocaleString()}. Click &quot;Full history&quot; to scan all.
    </span>
  );
}

// ── Event row ─────────────────────────────────────────────────────────────────

function EventRow({ e }: { e: ActivityEvent }) {
  const colorClass = eventTypeColor(e.type);

  function amountCell() {
    switch (e.type) {
      case "PaymentSettled": return (
        <span className="tabular font-semibold text-[var(--success)]">
          {e.amount !== undefined ? formatUsdcShort(e.amount) : "—"}
        </span>
      );
      case "SessionFunded": return (
        <span className="tabular font-semibold text-blue-400">
          +{e.fundAmount !== undefined ? formatUsdcShort(e.fundAmount) : "—"}
        </span>
      );
      case "SessionClosed": return (
        <span className="tabular text-[var(--muted)]">
          {e.refunded !== undefined ? `refund ${formatUsdcShort(e.refunded)}` : "—"}
        </span>
      );
      case "SessionCreated": return (
        <span className="tabular text-[var(--subtle)]">
          cap {e.perPaymentCap !== undefined ? formatUsdcShort(e.perPaymentCap) : "—"}/call
        </span>
      );
    }
  }

  function detailCell() {
    switch (e.type) {
      case "PaymentSettled":
        return e.paymentAgent ? <AddrLink address={e.paymentAgent} /> : <span className="text-[var(--subtle)]">—</span>;
      case "SessionFunded":
      case "SessionClosed":
      case "SessionCreated":
        return e.owner ? <AddrLink address={e.owner} /> : <span className="text-[var(--subtle)]">—</span>;
    }
  }

  return (
    <tr className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface)] transition-colors">
      <td className="px-4 py-3">
        <TxLink hash={e.txHash} />
      </td>
      <td className="px-4 py-3">
        <span className={`text-xs font-semibold ${colorClass}`}>
          {eventTypeLabel(e.type)}
        </span>
      </td>
      <td className="px-4 py-3 tabular font-semibold text-[var(--accent)] text-xs">
        #{e.sessionId.toString()}
      </td>
      <td className="px-4 py-3 text-xs">{amountCell()}</td>
      <td className="px-4 py-3 text-xs">{detailCell()}</td>
      <td className="px-4 py-3 tabular text-xs text-[var(--subtle)]">
        {e.blockNumber.toString()}
      </td>
    </tr>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function PaymentHistory() {
  const [result,   setResult]   = useState<CoverageResult | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [tab,      setTab]      = useState<ActivityEventTab>("all");
  const [page,     setPage]     = useState(0);

  const abortRef = useRef<AbortController | null>(null);

  // Derived: events for the active tab, newest-first
  const tabEvents = result
    ? [...filterByTab(result.events, tab)].reverse()
    : [];
  const totalPages  = Math.ceil(tabEvents.length / PAGE_SIZE);
  const pageEvents  = tabEvents.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Tab counts
  function tabCount(t: ActivityEventTab): number {
    if (!result) return 0;
    return filterByTab(result.events, t).length;
  }

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setLoading(false);
  }, []);

  const load = useCallback(async (fullHistory: boolean) => {
    // Cancel any in-progress scan
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setLoading(true);
    setError(null);
    setProgress(null);

    try {
      let scanResult: CoverageResult;

      if (fullHistory) {
        // Check if we have a recent checkpoint covering the full range
        const cached = loadCheckpoint(CHAIN_ID, BUDGET_RAIL_ADDRESS, DEPLOY_BLOCK_TESTNET);
        if (cached) {
          // We have a cached baseline; scan only new blocks on top
          const fromBlock = cached.toBlock + 1n;
          const existing = cached.events;
          const newResult = await scanAllEvents(BUDGET_RAIL_ADDRESS, {
            fromBlock,
            signal:     ctrl.signal,
            onProgress: setProgress,
          });

          // Merge, dedup, re-sort
          const seen = new Set(existing.map(e => e.key));
          const merged = [...existing];
          for (const e of newResult.events) {
            if (!seen.has(e.key)) { seen.add(e.key); merged.push(e); }
          }
          merged.sort((a, b) => {
            if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
            return a.logIndex - b.logIndex;
          });

          scanResult = {
            ...newResult,
            events:      merged,
            scannedFrom: DEPLOY_BLOCK_TESTNET,
            isComplete:  newResult.failedRanges.length === 0 && !ctrl.signal.aborted,
          };
        } else {
          scanResult = await scanAllEvents(BUDGET_RAIL_ADDRESS, {
            signal:     ctrl.signal,
            onProgress: setProgress,
          });
        }

        // Persist checkpoint for next refresh
        if (!ctrl.signal.aborted) {
          saveCheckpoint(CHAIN_ID, BUDGET_RAIL_ADDRESS,
            DEPLOY_BLOCK_TESTNET, scanResult.scannedTo, scanResult.events);
        }
      } else {
        scanResult = await scanRecentEvents(BUDGET_RAIL_ADDRESS, 3, {
          signal:     ctrl.signal,
          onProgress: setProgress,
        });
      }

      if (!ctrl.signal.aborted) {
        setResult(scanResult);
        setPage(0);
        if (scanResult.failedRanges.length > 0) {
          setError(
            `${scanResult.failedRanges.length} block window(s) failed after retries. ` +
            `History may be incomplete. Failed ranges: ` +
            scanResult.failedRanges
              .slice(0, 3)
              .map(r => `${r.fromBlock}–${r.toBlock}`)
              .join(", ") +
            (scanResult.failedRanges.length > 3 ? " …" : ""),
          );
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) {
        setError((e as Error).message);
      }
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, []);

  function handleClearCache() {
    clearCheckpoint(CHAIN_ID, BUDGET_RAIL_ADDRESS, DEPLOY_BLOCK_TESTNET);
    setResult(null);
    setError(null);
    setProgress(null);
  }

  // Progress percentage
  const progressPct = progress
    ? Math.round((progress.windowsDone / Math.max(1, progress.windowsTotal)) * 100)
    : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="display font-bold text-2xl text-[var(--ink)] tracking-tight">
            Activity History
          </h1>
          <p className="text-sm text-[var(--subtle)] mt-1">
            All BudgetRail events: session creation, USDC deposits, agent payments and refunds.
            Source: <span className="mono text-xs">{BUDGET_RAIL_ADDRESS}</span>
          </p>
        </div>
        <div className="flex gap-2 flex-shrink-0 flex-wrap">
          {loading ? (
            <button
              onClick={cancel}
              className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)]
                         bg-[var(--surface)] text-[var(--danger)] px-4 py-2.5 text-sm font-semibold
                         hover:bg-[var(--surface-strong)] transition-colors"
            >
              Cancel
            </button>
          ) : (
            <>
              <button
                onClick={() => { void load(false); }}
                className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] text-[#0d1b2f]
                           px-4 py-2.5 text-sm font-semibold hover:bg-[var(--accent-hover)]
                           disabled:opacity-50 transition-colors"
              >
                <RefreshCw size={14} />
                {result ? "Refresh" : "Load recent"}
              </button>
              {result && (
                <button
                  onClick={() => { void load(true); }}
                  className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)]
                             bg-[var(--surface)] text-[var(--ink-2)] px-4 py-2.5 text-sm font-semibold
                             hover:bg-[var(--surface-strong)] transition-colors"
                  title="Scan all blocks from contract deployment"
                >
                  Full history
                </button>
              )}
              {result && (
                <button
                  onClick={handleClearCache}
                  className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)]
                             bg-[var(--surface)] text-[var(--subtle)] px-3 py-2.5 text-xs
                             hover:bg-[var(--surface-strong)] transition-colors"
                  title="Clear local cache and rescan"
                >
                  Clear cache
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Errors */}
      {error && (
        <ErrorBanner
          message={error}
          onDismiss={() => setError(null)}
        />
      )}

      {/* Progress bar */}
      {loading && (
        <div className="space-y-1.5">
          <div className="h-1.5 w-full bg-[var(--surface-strong)] rounded-full overflow-hidden">
            <div
              className="h-full bg-[var(--accent)] transition-all duration-300 rounded-full"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p className="text-xs text-[var(--subtle)]">
            {progress
              ? `Scanning block ${progress.scannedBlock.toLocaleString()} / ${progress.headBlock.toLocaleString()} — window ${progress.windowsDone}/${progress.windowsTotal} — ${progress.eventsSoFar} events so far`
              : "Connecting…"
            }
          </p>
        </div>
      )}

      {/* Coverage badge */}
      {result && !loading && (
        <div className="px-1">
          <CoverageBadge result={result} />
        </div>
      )}

      {/* Tabs */}
      {result && (
        <div className="flex gap-1 border-b border-[var(--border)]">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => { setTab(t.id); setPage(0); }}
              className={`px-4 py-2.5 text-sm font-medium transition-colors -mb-px border-b-2 ${
                tab === t.id
                  ? "border-[var(--accent)] text-[var(--accent)]"
                  : "border-transparent text-[var(--subtle)] hover:text-[var(--ink)]"
              }`}
            >
              {t.label}
              <span className="ml-1.5 text-xs opacity-70">
                ({tabCount(t.id)})
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      {!result ? (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-10 text-center space-y-3">
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : (
            <>
              <p className="text-sm text-[var(--subtle)]">
                Click <strong>Load recent</strong> for the last ~30k blocks,
                or <strong>Full history</strong> to scan from contract deployment (block {DEPLOY_BLOCK_TESTNET.toLocaleString()}).
              </p>
              <p className="text-xs text-[var(--subtle)]">
                Results are derived exclusively from the deployed BudgetRail contract.
              </p>
            </>
          )}
        </div>
      ) : loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-12 w-full" />)}
        </div>
      ) : tabEvents.length === 0 ? (
        <EmptyState
          title={`No ${tab === "all" ? "activity" : tab} found`}
          body={
            result.isComplete
              ? `No ${tab === "all" ? "events" : tab} found from contract deployment to block ${result.scannedTo.toLocaleString()}.`
              : `No ${tab === "all" ? "events" : tab} found in scanned range (${result.scannedFrom.toLocaleString()} – ${result.scannedTo.toLocaleString()}). ` +
                `Click "Full history" to scan from deployment (block ${DEPLOY_BLOCK_TESTNET.toLocaleString()}).`
          }
        />
      ) : (
        <>
          <div className="text-xs text-[var(--subtle)]">
            {tabEvents.length} event{tabEvents.length !== 1 ? "s" : ""}
            {tab !== "all" ? ` (${tab})` : ""}
          </div>
          <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
            <table className="w-full text-xs min-w-[680px]">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--surface-muted)]">
                  {["Tx", "Type", "Session", "Amount / Info", "Owner / Agent", "Block"].map(h => (
                    <th key={h} className="text-left px-4 py-3 font-semibold text-[var(--subtle)]">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageEvents.map(e => <EventRow key={e.key} e={e} />)}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className="inline-flex items-center gap-1 text-sm text-[var(--muted)] disabled:opacity-40 hover:text-[var(--ink)] transition-colors"
              >
                <ChevronLeft size={16} /> Prev
              </button>
              <p className="text-xs text-[var(--subtle)]">Page {page + 1} of {totalPages}</p>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="inline-flex items-center gap-1 text-sm text-[var(--muted)] disabled:opacity-40 hover:text-[var(--ink)] transition-colors"
              >
                Next <ChevronRight size={16} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
