/**
 * Page 4 — Payment History (/payments)
 * PaymentSettled events from BudgetRail, windowed eth_getLogs (<10 000 blocks per request),
 * with cursor-based pagination, session/agent/provider filter, and verified event source.
 */
import { useState, useCallback } from "react";
import { parseAbi } from "viem";

import { Search, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { BUDGET_RAIL_ADDRESS, DEPLOY_BLOCK_TESTNET } from "@/lib/budgetRail";
import { formatUsdcShort } from "@/lib/format";
import { TxLink, AddrLink } from "@/components/ExplorerLink";
import { ErrorBanner, EmptyState, Skeleton } from "@/components/shared";

const WINDOW_SIZE       = 9_999n;  // <10 000 per getLogs call (RPC limit)
const PAGE_SIZE         = 20;
const SCAN_WINDOWS      = 5;       // default: scan last 5 × 9999 ≈ 50k blocks
const BACKOFF_MS        = 1_200;   // delay between windows to avoid RPC rate-limits
const MAX_FULL_WINDOWS  = 500;     // safety cap for full-history scan (~5M blocks)

// ── Types ──────────────────────────────────────────────────────────────────

interface PaymentEvent {
  txHash:      string;
  blockNumber: bigint;
  logIndex:    number;
  sessionId:   bigint;
  requestId:   string;
  requestHash: string;
  provider:    string;
  agent:       string;
  amount:      bigint;
  quoteDeadline: bigint;
}

// ── Data fetching ──────────────────────────────────────────────────────────

interface FetchResult {
  events:      PaymentEvent[];
  scannedFrom: bigint;   // lowest block actually scanned
  chainHead:   bigint;   // chain head at time of scan
  fullHistory: boolean;  // true when scan reached DEPLOY_BLOCK_TESTNET
}

async function fetchPaymentEvents(
  contractAddress: `0x${string}`,
  fullHistory = false,
  onProgress?: (pct: number) => void,
): Promise<FetchResult> {
  const { createPublicClient, http } = await import("viem");
  const { arcTestnet: chain } = await import("viem/chains");
  const client = createPublicClient({ chain, transport: http() });

  const latest = await client.getBlockNumber();
  const PAYMENT_SETTLED_ABI = parseAbi([
    "event PaymentSettled(uint256 indexed sessionId, bytes32 indexed requestId, address indexed provider, bytes32 requestHash, address agent, uint96 amount, uint64 quoteDeadline)",
  ]);

  const seenKeys = new Set<string>();
  const events: PaymentEvent[] = [];
  const maxWindows = fullHistory ? MAX_FULL_WINDOWS : SCAN_WINDOWS;
  let scannedFrom = latest;
  let reachedDeploy = false;

  for (let i = 0; i < maxWindows; i++) {
    const toBlock   = latest - BigInt(i) * WINDOW_SIZE;
    // Never scan below deploy block — the contract didn't exist before that
    const fromBlock = toBlock >= WINDOW_SIZE + DEPLOY_BLOCK_TESTNET
      ? toBlock - WINDOW_SIZE
      : DEPLOY_BLOCK_TESTNET;
    if (fromBlock > toBlock || toBlock < DEPLOY_BLOCK_TESTNET) { reachedDeploy = true; break; }
    if (fromBlock <= DEPLOY_BLOCK_TESTNET) reachedDeploy = true;

    scannedFrom = fromBlock;
    onProgress?.(Math.min(99, Math.round((i / maxWindows) * 100)));

    const logs = await client.getLogs({
      address: contractAddress,
      event: PAYMENT_SETTLED_ABI[0],
      fromBlock,
      toBlock,
    });

    for (const log of logs) {
      const key = `${log.transactionHash ?? ""}-${log.logIndex ?? 0}`;
      if (seenKeys.has(key)) continue; // deduplicate across overlapping windows
      seenKeys.add(key);
      const a = log.args;
      events.push({
        txHash:        log.transactionHash ?? "",
        blockNumber:   log.blockNumber ?? 0n,
        logIndex:      log.logIndex ?? 0,
        sessionId:     a.sessionId as bigint,
        requestId:     (a.requestId as string) ?? "",
        requestHash:   (a.requestHash as string) ?? "",
        provider:      (a.provider as string) ?? "",
        agent:         (a.agent as string) ?? "",
        amount:        a.amount as bigint,
        quoteDeadline: a.quoteDeadline as bigint,
      });
    }

    if (reachedDeploy) break;
    // Backoff between windows to avoid RPC rate-limits
    if (i < maxWindows - 1) await new Promise(r => setTimeout(r, BACKOFF_MS));
  }

  onProgress?.(100);

  // Sort: descending by blockNumber, then logIndex
  events.sort((a, b) => {
    if (b.blockNumber !== a.blockNumber) return b.blockNumber > a.blockNumber ? 1 : -1;
    return b.logIndex - a.logIndex;
  });

  return { events, scannedFrom, chainHead: latest, fullHistory: reachedDeploy };
}

// ── Page component ─────────────────────────────────────────────────────────

export function PaymentHistory() {
  const [events,       setEvents]       = useState<PaymentEvent[]>([]);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [fetched,      setFetched]      = useState(false);
  const [page,         setPage]         = useState(0);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanMeta,     setScanMeta]     = useState<{ scannedFrom: bigint; chainHead: bigint; fullHistory: boolean } | null>(null);

  const [filterSession,  setFilterSession]  = useState("");
  const [filterAgent,    setFilterAgent]    = useState("");
  const [filterProvider, setFilterProvider] = useState("");

  const load = useCallback(async (fullHistory = false) => {
    setLoading(true);
    setError(null);
    setScanProgress(0);
    try {
      const result = await fetchPaymentEvents(BUDGET_RAIL_ADDRESS, fullHistory, setScanProgress);
      setEvents(result.events);
      setScanMeta({ scannedFrom: result.scannedFrom, chainHead: result.chainHead, fullHistory: result.fullHistory });
      setFetched(true);
      setPage(0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      setScanProgress(100);
    }
  }, []);

  // Filter
  const filtered = events.filter(e => {
    if (filterSession  && !e.sessionId.toString().includes(filterSession.trim())) return false;
    if (filterAgent    && !e.agent.toLowerCase().includes(filterAgent.trim().toLowerCase())) return false;
    if (filterProvider && !e.provider.toLowerCase().includes(filterProvider.trim().toLowerCase())) return false;
    return true;
  });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const page_events = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="display font-bold text-2xl text-[var(--ink)] tracking-tight">Payment History</h1>
          <p className="text-sm text-[var(--subtle)] mt-1">
            Agent payments only — not session creation or USDC deposits.
            Each row is a confirmed <span className="mono text-xs">PaymentSettled</span> event from the BudgetRail contract.
          </p>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button
            onClick={() => { void load(false); }}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] text-[#0d1b2f]
                       px-4 py-2.5 text-sm font-semibold hover:bg-[var(--accent-hover)]
                       disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            {fetched ? "Refresh" : "Load events"}
          </button>
          {fetched && scanMeta && !scanMeta.fullHistory && !loading && (
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
        </div>
      </div>

      {error && <ErrorBanner message={`RPC error: ${error}. Arc Testnet may be rate-limiting. Try again shortly.`} onDismiss={() => setError(null)} />}

      {/* Scan progress bar */}
      {loading && (
        <div className="space-y-1">
          <div className="h-1 w-full bg-[var(--surface-strong)] rounded-full overflow-hidden">
            <div
              className="h-full bg-[var(--accent)] transition-all duration-300 rounded-full"
              style={{ width: `${scanProgress}%` }}
            />
          </div>
          <p className="text-xs text-[var(--subtle)]">
            Scanning blocks… {scanProgress < 100 ? `${scanProgress}%` : "done"}
          </p>
        </div>
      )}

      {/* Incomplete-history notice — never label unscanned history as "no payments" */}
      {fetched && scanMeta && !scanMeta.fullHistory && !loading && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-xs text-[var(--subtle)] space-y-1">
          <p>
            Showing events from block <span className="mono tabular">{scanMeta.scannedFrom.toLocaleString()}</span> to{" "}
            <span className="mono tabular">{scanMeta.chainHead.toLocaleString()}</span> (~50k blocks).
            The contract was deployed at block <span className="mono tabular">{DEPLOY_BLOCK_TESTNET.toLocaleString()}</span>.
          </p>
          <p>
            Older payments may exist but are not shown. Click <strong>Full history</strong> to scan from deployment.
            This will take longer and may trigger rate-limiting.
          </p>
        </div>
      )}
      {fetched && scanMeta?.fullHistory && !loading && (
        <p className="text-xs text-[var(--subtle)]">
          Full history scanned: blocks {DEPLOY_BLOCK_TESTNET.toLocaleString()} – {scanMeta.chainHead.toLocaleString()}.
        </p>
      )}

      {/* Filters */}
      {fetched && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            { label: "Session ID", value: filterSession, set: setFilterSession, placeholder: "e.g. 1" },
            { label: "Agent",      value: filterAgent,   set: setFilterAgent,   placeholder: "0x..." },
            { label: "Provider",   value: filterProvider, set: setFilterProvider, placeholder: "0x..." },
          ].map(({ label, value, set, placeholder }) => (
            <div key={label} className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--subtle)]" />
              <input
                type="text"
                value={value}
                onChange={e => { set(e.target.value); setPage(0); }}
                placeholder={`Filter by ${label}: ${placeholder}`}
                className="w-full pl-8 pr-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]
                           text-xs text-[var(--ink)] placeholder:text-[var(--subtle)]
                           focus:outline-none focus:ring-2 focus:ring-[var(--focus)]"
              />
            </div>
          ))}
        </div>
      )}

      {/* Table */}
      {!fetched ? (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
          <p className="text-sm text-[var(--subtle)]">
            Click "Load events" to fetch PaymentSettled events from Arc Testnet.
            Results are derived exclusively from the deployed BudgetRail contract address.
          </p>
        </div>
      ) : loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-12 w-full" />)}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={events.length > 0 ? "No events match filter" : scanMeta?.fullHistory ? "No payments found" : "No payments in scanned range"}
          body={events.length > 0
            ? "No PaymentSettled events match the current filter. Try clearing the filters."
            : scanMeta?.fullHistory
            ? "No PaymentSettled events found between contract deployment and the current block. Once an agent pays via BudgetRail, each payment appears here."
            : "No PaymentSettled events found in the last ~50,000 blocks. Older payments may exist — click 'Full history' to scan from contract deployment (block 67,538,363)."}
        />
      ) : (
        <>
          <div className="text-xs text-[var(--subtle)]">
            {filtered.length} event{filtered.length !== 1 ? "s" : ""}
            {(filterSession || filterAgent || filterProvider) ? " (filtered)" : ""}
          </div>
          <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
            <table className="w-full text-xs min-w-[700px]">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--surface-muted)]">
                  {["Tx", "Block", "Session", "Amount", "Agent", "Provider", "Deadline"].map(h => (
                    <th key={h} className="text-left px-4 py-3 font-semibold text-[var(--subtle)]">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page_events.map((e, _i) => (
                  <tr
                    key={`${e.txHash}-${e.logIndex}`}
                    className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface)] transition-colors"
                  >
                    <td className="px-4 py-3"><TxLink hash={e.txHash} /></td>
                    <td className="px-4 py-3 tabular text-[var(--subtle)]">{e.blockNumber.toString()}</td>
                    <td className="px-4 py-3 tabular font-semibold text-[var(--accent)]">#{e.sessionId.toString()}</td>
                    <td className="px-4 py-3 tabular font-semibold text-[var(--success)]">{formatUsdcShort(e.amount)}</td>
                    <td className="px-4 py-3"><AddrLink address={e.agent} /></td>
                    <td className="px-4 py-3"><AddrLink address={e.provider} /></td>
                    <td className="px-4 py-3 text-[var(--subtle)]">
                      {new Date(Number(e.quoteDeadline) * 1000).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
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
