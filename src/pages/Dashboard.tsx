/**
 * Page 1 — Dashboard (/)
 * Wallet status, onchain USDC balance, session list (paginated), recent PaymentSettled events.
 * Read-only functions work without wallet; balances need a connected address.
 */
import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useAccount, useReadContract, useReadContracts, usePublicClient } from "wagmi";
import { erc20Abi } from "viem";
import { arcTestnet } from "viem/chains";
import { PlusCircle, RefreshCw, ChevronLeft, ChevronRight, Zap, UserCheck } from "lucide-react";
import { ConnectKitButton } from "connectkit";
import { getUsdc } from "@/onchain-facts";
import { formatUsdcShort, formatAddr, formatTs, sessionStatus, isExpired } from "@/lib/format";
import { BUDGET_RAIL_ABI, BUDGET_RAIL_ADDRESS, type SessionTuple } from "@/lib/budgetRail";
import { scanRecentEvents, type ActivityEvent } from "@/lib/historyScanner";
import { NetworkBadge } from "@/components/NetworkGuard";
import { TxLink, AddrLink } from "@/components/ExplorerLink";
import { SkeletonCard, EmptyState, ErrorBanner, StatusBadge } from "@/components/shared";
import { SessionNavLink } from "@/components/Layout";

const CHAIN_ID = arcTestnet.id;
const USDC     = getUsdc(CHAIN_ID)!;
const PAGE_SIZE = 5;

// ── Hooks ──────────────────────────────────────────────────────────────────

function useOwnerSessions(owner: `0x${string}` | undefined, page: number) {
  const offset = BigInt(page * PAGE_SIZE);

  const { data: count, isLoading: countLoading } = useReadContract({
    address: BUDGET_RAIL_ADDRESS,
    abi: BUDGET_RAIL_ABI,
    functionName: "ownerSessionCount",
    args: [owner ?? "0x0000000000000000000000000000000000000000"],
    chainId: CHAIN_ID,
    query: { enabled: !!owner, refetchInterval: 20_000 },
  });

  const { data: ids, isLoading: idsLoading } = useReadContract({
    address: BUDGET_RAIL_ADDRESS,
    abi: BUDGET_RAIL_ABI,
    functionName: "sessionIdsByOwner",
    args: [
      owner ?? "0x0000000000000000000000000000000000000000",
      offset,
      BigInt(PAGE_SIZE),
    ],
    chainId: CHAIN_ID,
    query: { enabled: !!owner && !!count && count > 0n, refetchInterval: 20_000 },
  });

  return { count: count, ids: ids as bigint[] | undefined, isLoading: countLoading || idsLoading };
}

function useSessionBatch(ids: bigint[] | undefined) {
  const contracts = (ids ?? []).map(id => ({
    address: BUDGET_RAIL_ADDRESS,
    abi: BUDGET_RAIL_ABI,
    functionName: "getSession" as const,
    args: [id] as [bigint],
    chainId: CHAIN_ID,
  }));

  const { data, isLoading } = useReadContracts({
    contracts,
    query: { enabled: (ids?.length ?? 0) > 0, refetchInterval: 20_000 },
  });

  return { sessions: data?.map(d => d.result), isLoading };
}

// ── Hook: sessions where connected wallet is agent B ──────────────────────
// Scans ALL SessionCreated logs for agent == address (from contract deploy block).
// Re-runs every time the agent address changes.
const DEPLOY_BLOCK = 67_538_363n; // BudgetRail V1 deploy block

function useAgentSessions(agent: `0x${string}` | undefined) {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const [sessionIds, setSessionIds] = useState<bigint[]>([]);
  const [loading, setLoading]       = useState(false);
  const [scanError, setScanError]   = useState<string | null>(null);
  const [coverage, setCoverage]     = useState<{ scanned: bigint; head: bigint } | null>(null);
  const prevAgent = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!agent || !publicClient) {
      setSessionIds([]);
      setScanError(null);
      setCoverage(null);
      prevAgent.current = undefined;
      return;
    }
    // Re-fetch whenever the wallet address changes
    if (prevAgent.current === agent.toLowerCase()) return;
    prevAgent.current = agent.toLowerCase();

    setSessionIds([]);
    setScanError(null);
    setCoverage(null);
    setLoading(true);
    void (async () => {
      try {
        const head = await publicClient.getBlockNumber();
        const allIds: bigint[] = [];
        const WINDOW = 10_000n;
        let lastScanned = DEPLOY_BLOCK;
        for (let from = DEPLOY_BLOCK; from <= head; from += WINDOW) {
          const to = from + WINDOW - 1n > head ? head : from + WINDOW - 1n;
          try {
            const logs = await publicClient.getLogs({
              address: BUDGET_RAIL_ADDRESS,
              event: {
                type: "event",
                name: "SessionCreated",
                inputs: [
                  { name: "sessionId", type: "uint256", indexed: true },
                  { name: "owner",     type: "address",  indexed: true },
                  { name: "agent",     type: "address",  indexed: true },
                ],
              },
              args:      { agent },
              fromBlock: from,
              toBlock:   to,
            });
            for (const l of logs) {
              const id = (l.args as { sessionId?: bigint }).sessionId;
              if (id !== undefined) allIds.push(id);
            }
            lastScanned = to;
          } catch {
            // Window failed — continue scanning remaining windows
            setScanError(`Scan partial: some blocks could not be read. Results may be incomplete.`);
          }
        }
        // Deduplicate and sort ascending
        const unique = [...new Map(allIds.map(id => [id.toString(), id])).values()]
          .sort((a, b) => (a < b ? -1 : 1));
        setSessionIds(unique);
        setCoverage({ scanned: lastScanned, head });
      } catch (err) {
        setScanError(err instanceof Error ? err.message : "RPC error during agent session scan");
      } finally {
        setLoading(false);
      }
    })();
  }, [agent, publicClient]);

  return { sessionIds, loading, scanError, coverage };
}

// ── Session card ───────────────────────────────────────────────────────────

function SessionCard({ id, session }: { id: bigint; session: SessionTuple }) {
  const available = session.totalFunded - session.totalSpent;
  const status    = sessionStatus(session.closed, session.expiresAt);

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 hover:bg-[var(--surface-strong)] transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="display font-bold text-[var(--accent)] text-lg tabular">#{id.toString()}</span>
          <StatusBadge status={status} />
        </div>
        <SessionNavLink sessionId={id} />
      </div>

      <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-xs">
        <div>
          <p className="text-[var(--subtle)]">Budget</p>
          <p className="font-semibold tabular">{formatUsdcShort(session.maxBudget)}</p>
        </div>
        <div>
          <p className="text-[var(--subtle)]">Available</p>
          <p className={`font-semibold tabular ${available === 0n ? "text-[var(--subtle)]" : "text-[var(--success)]"}`}>
            {formatUsdcShort(available)}
          </p>
        </div>
        <div>
          <p className="text-[var(--subtle)]">Spent</p>
          <p className="font-semibold tabular">{formatUsdcShort(session.totalSpent)}</p>
        </div>
        <div>
          <p className="text-[var(--subtle)]">Agent</p>
          <AddrLink address={session.agent} />
        </div>
        <div>
          <p className="text-[var(--subtle)]">Expires</p>
          <p className="text-[var(--muted)]">
            {isExpired(session.expiresAt) ? "Expired" : formatTs(session.expiresAt)}
          </p>
        </div>
        <div>
          <p className="text-[var(--subtle)]">Per-call cap</p>
          <p className="font-medium tabular">{formatUsdcShort(session.perPaymentCap)}</p>
        </div>
      </div>
    </div>
  );
}

// ── Recent ALL events — windowed scan, 3 windows (~30k blocks) ───────────────
// Uses historyScanner which: batches getLogs, retries on 429, deduplicates,
// and returns explicit coverage metadata. Never makes a single unbounded call.

function useRecentPayments(contractAddress: `0x${string}`) {
  const [events,  setEvents]  = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [fetched, setFetched] = useState(false);

  async function fetchEvents() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await scanRecentEvents(contractAddress, 3);
      // Keep only PaymentSettled for the dashboard summary; newest-first, max 10
      const payments = [...result.events]
        .filter(e => e.type === "PaymentSettled")
        .sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : -1))
        .slice(0, 10);
      setEvents(payments);
      setFetched(true);
      if (result.failedRanges.length > 0) {
        setError(`${result.failedRanges.length} scan window(s) failed — data may be incomplete`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return { events, loading, error, fetched, fetchEvents };
}

// ── Dashboard ──────────────────────────────────────────────────────────────

export function Dashboard() {
  const { address, isConnected } = useAccount();
  const [page, setPage] = useState(0);

  const { data: usdcBalance, isLoading: balanceLoading } = useReadContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    chainId: CHAIN_ID,
    query: { enabled: !!address, refetchInterval: 15_000 },
  });

  const { count, ids, isLoading: sessionsLoading } = useOwnerSessions(address, page);
  const { sessions, isLoading: batchLoading } = useSessionBatch(ids);
  const { sessionIds: agentSessionIds, loading: agentLoading, scanError: agentScanError, coverage: agentCoverage } = useAgentSessions(address);
  const { sessions: agentSessions } = useSessionBatch(agentSessionIds);
  const { events, loading: eventsLoading, error: eventsError, fetched, fetchEvents } = useRecentPayments(BUDGET_RAIL_ADDRESS);

  const totalPages = count ? Math.ceil(Number(count) / PAGE_SIZE) : 0;
  const isLoading  = sessionsLoading || batchLoading;

  // Aggregate stats from loaded sessions
  const stats = sessions?.reduce((acc, s) => {
    if (!s) return acc;
    const st = sessionStatus(s.closed, s.expiresAt);
    return {
      totalFunded: acc.totalFunded + s.totalFunded,
      totalSpent:  acc.totalSpent  + s.totalSpent,
      active:  acc.active  + (st === "active"  ? 1 : 0),
      expired: acc.expired + (st === "expired" ? 1 : 0),
      closed:  acc.closed  + (st === "closed"  ? 1 : 0),
    };
  }, { totalFunded: 0n, totalSpent: 0n, active: 0, expired: 0, closed: 0 }) ?? null;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="display font-bold text-2xl text-[var(--ink)] tracking-tight">Dashboard</h1>
          <p className="text-sm text-[var(--subtle)] mt-1">Manage USDC payment sessions on Arc Testnet</p>
        </div>
        <div className="flex items-center gap-3">
          <NetworkBadge />
          {isConnected && (
            <Link
              to="/create"
              className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] text-[#0d1b2f]
                         px-4 py-2.5 text-sm font-semibold hover:bg-[var(--accent-hover)] transition-colors"
            >
              <PlusCircle size={16} />
              New Budget
            </Link>
          )}
        </div>
      </div>

      {/* Wallet section */}
      {!isConnected ? (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 flex flex-col items-center gap-4 text-center">
          <p className="display font-bold text-xl text-[var(--ink)]">Connect your wallet</p>
          <p className="text-sm text-[var(--subtle)] max-w-xs">
            Connect wallet A (owner) to view your sessions and USDC balance.
          </p>
          <ConnectKitButton />
        </div>
      ) : (
        <>
          {/* Balance hero */}
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
            <p className="text-xs text-[var(--subtle)] mb-1">USDC ERC-20 balance (6-decimal view)</p>
            <p className="display font-bold text-3xl text-[var(--ink)] tabular">
              {balanceLoading ? "…" : formatUsdcShort((usdcBalance as bigint) ?? 0n)}
            </p>
            <p className="text-xs text-[var(--subtle)] mt-1">
              <AddrLink address={address!} label={formatAddr(address!)} />
              {" "}&mdash; Note: native USDC gas balance is separate (18 dec, same pool, not summed here)
            </p>
          </div>

          {/* Run first paid job CTA — shown when there are funded sessions with available balance */}
          {stats && stats.active > 0 && stats.totalFunded > stats.totalSpent && (
            <div className="rounded-2xl border border-[rgba(141,216,159,0.2)] bg-[rgba(141,216,159,0.05)] p-4 flex items-center justify-between gap-4">
              <div>
                <p className="font-semibold text-[var(--success)] text-sm">Ready for a paid job</p>
                <p className="text-xs text-[var(--muted)] mt-0.5">
                  You have {formatUsdcShort(stats.totalFunded - stats.totalSpent)} available across {stats.active} active session{stats.active !== 1 ? "s" : ""}.
                  Run the Playground to make your first real agent payment.
                </p>
              </div>
              <Link
                to="/playground"
                className="shrink-0 inline-flex items-center gap-2 rounded-xl bg-[var(--success)] text-[#0d2010]
                           px-4 py-2.5 text-sm font-semibold hover:opacity-90 transition-opacity"
              >
                <Zap size={14} />
                Run job
              </Link>
            </div>
          )}

          {/* Aggregate stats */}
          {stats && count && count > 0n && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: "Total funded",    value: formatUsdcShort(stats.totalFunded) },
                { label: "Total spent",     value: formatUsdcShort(stats.totalSpent)  },
                { label: "Active sessions", value: stats.active.toString()            },
                { label: "Closed/expired",  value: (stats.closed + stats.expired).toString() },
              ].map(({ label, value }) => (
                <div key={label} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                  <p className="text-xs text-[var(--subtle)]">{label}</p>
                  <p className="font-semibold tabular mt-0.5 text-[var(--ink)]">{value}</p>
                </div>
              ))}
            </div>
          )}

          {/* Session list */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="display font-semibold text-lg text-[var(--ink-2)]">
                Your sessions {count !== undefined && `(${count.toString()})`}
              </h2>
            </div>

            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map(i => <SkeletonCard key={i} />)}
              </div>
            ) : !count || count === 0n ? (
              <EmptyState
                title="No sessions yet"
                body="Create a budget session to start making authorized USDC payments."
                action={
                  <Link to="/create"
                    className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] text-[#0d1b2f]
                               px-4 py-2 text-sm font-semibold hover:bg-[var(--accent-hover)] transition-colors">
                    <PlusCircle size={14} />
                    Create session
                  </Link>
                }
              />
            ) : (
              <div className="space-y-3">
                {(ids ?? []).map((id, i) => {
                  const s = sessions?.[i];
                  return s
                    ? <SessionCard key={id.toString()} id={id} session={s} />
                    : <SkeletonCard key={id.toString()} />;
                })}
              </div>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="inline-flex items-center gap-1 text-sm text-[var(--muted)] disabled:opacity-40
                             hover:text-[var(--ink)] transition-colors"
                >
                  <ChevronLeft size={16} /> Prev
                </button>
                <p className="text-xs text-[var(--subtle)]">Page {page + 1} of {totalPages}</p>
                <button
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="inline-flex items-center gap-1 text-sm text-[var(--muted)] disabled:opacity-40
                             hover:text-[var(--ink)] transition-colors"
                >
                  Next <ChevronRight size={16} />
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {/* Agent Sessions tab — always shown when connected */}
      {isConnected && (
        <div>
          <div className="flex items-center gap-2 mb-1">
            <UserCheck size={16} className="text-[var(--accent)]" />
            <h2 className="display font-semibold text-lg text-[var(--ink-2)]">
              Agent Sessions
              {!agentLoading && agentSessionIds.length > 0 && (
                <span className="ml-1 text-[var(--subtle)] font-normal">({agentSessionIds.length})</span>
              )}
            </h2>
          </div>
          <p className="text-xs text-[var(--subtle)] mb-3">
            Sessions where <span className="mono">{address && formatAddr(address)}</span> is authorized as agent B — you can pay for API calls from these in the Playground.
            Identity verified from onchain <span className="mono">SessionCreated</span> logs (V1 contract, block {DEPLOY_BLOCK.toString()}+).
          </p>

          {/* Coverage / error badge */}
          {agentScanError && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 mb-3 text-xs text-amber-200/80">
              {agentScanError.includes("503") || agentScanError.includes("fetch") || agentScanError.includes("RPC")
                ? "RPC temporarily unavailable — scan incomplete. Results shown may be partial. Refresh when RPC recovers."
                : agentScanError}
            </div>
          )}
          {!agentLoading && !agentScanError && agentCoverage && (
            <p className="text-xs text-[var(--subtle)] mb-3">
              Scan complete: blocks {DEPLOY_BLOCK.toString()} — {agentCoverage.head.toString()}.
              {agentCoverage.scanned < agentCoverage.head && (
                <span className="text-amber-400"> (some windows failed — data may be partial)</span>
              )}
            </p>
          )}

          {agentLoading ? (
            <div className="space-y-3">{[1,2].map(i => <SkeletonCard key={i} />)}</div>
          ) : agentSessionIds.length === 0 ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-5 text-center">
              <p className="text-sm text-[var(--muted)]">No agent sessions found for this wallet.</p>
              <p className="text-xs text-[var(--subtle)] mt-1">
                {agentScanError
                  ? "Scan did not complete — retry when RPC is available."
                  : "Ask an owner to create a session with your address as agent B, then share the session link."}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {agentSessionIds.map((id, i) => {
                const s = agentSessions?.[i];
                if (!s) return <SkeletonCard key={id.toString()} />;
                const available = s.totalFunded - s.totalSpent;
                const status    = sessionStatus(s.closed, s.expiresAt);
                return (
                  <div key={id.toString()} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 hover:bg-[var(--surface-strong)] transition-colors">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="display font-bold text-[var(--accent)] text-lg tabular">#{id.toString()}</span>
                        <StatusBadge status={status} />
                        <span className="text-xs px-2 py-0.5 rounded-full bg-[rgba(66,184,224,0.12)] text-[var(--accent)] font-medium">Agent B</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Link
                          to={`/sessions/${id.toString()}`}
                          className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)]
                                     bg-[var(--surface-muted)] px-2.5 py-1.5 text-xs text-[var(--muted)]
                                     hover:text-[var(--ink)] transition-colors"
                        >
                          Details
                        </Link>
                        {!s.closed && !isExpired(s.expiresAt) && available > 0n && (
                          <Link
                            to={`/playground?session=${id.toString()}`}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] text-[#0d1b2f]
                                       px-3 py-1.5 text-xs font-semibold hover:bg-[var(--accent-hover)] transition-colors"
                          >
                            <Zap size={12} />
                            Pay
                          </Link>
                        )}
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-xs">
                      <div>
                        <p className="text-[var(--subtle)]">Available</p>
                        <p className={`font-semibold tabular ${available === 0n ? "text-[var(--subtle)]" : "text-[var(--success)]"}`}>
                          {formatUsdcShort(available)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[var(--subtle)]">Per-call cap</p>
                        <p className="font-semibold tabular">{formatUsdcShort(s.perPaymentCap)}</p>
                      </div>
                      <div>
                        <p className="text-[var(--subtle)]">Expires</p>
                        <p className="text-[var(--muted)]">{isExpired(s.expiresAt) ? "Expired" : formatTs(s.expiresAt)}</p>
                      </div>
                      <div>
                        <p className="text-[var(--subtle)]">Owner</p>
                        <AddrLink address={s.owner} />
                      </div>
                      <div>
                        <p className="text-[var(--subtle)]">Provider payout C</p>
                        <AddrLink address={s.provider} />
                        <p className="text-[var(--subtle)] mt-0.5">Service revenue — not connected wallet</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Recent PaymentSettled events */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="display font-semibold text-lg text-[var(--ink-2)]">Recent Payments</h2>
          <button
            onClick={() => { void fetchEvents(); }}
            disabled={eventsLoading}
            className="inline-flex items-center gap-1.5 text-xs text-[var(--accent)] hover:text-[var(--accent-hover)]
                       transition-colors disabled:opacity-50"
          >
            <RefreshCw size={13} className={eventsLoading ? "animate-spin" : ""} />
            {fetched ? "Refresh" : "Load"}
          </button>
        </div>

        {eventsError && (
          <ErrorBanner message={`Could not load events: ${eventsError}`} className="mb-3" />
        )}

        {!fetched ? (
          <p className="text-sm text-[var(--subtle)]">Click Load to fetch recent PaymentSettled events from Arc Testnet.</p>
        ) : events.length === 0 ? (
          <EmptyState title="No payments yet" body="No PaymentSettled events found from contract deployment to current block. Once an agent pays via BudgetRail the payment will appear here." />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--border)] text-[var(--subtle)]">
                  {["Tx", "Session", "Amount", "Agent", "Provider", "Block"].map(h => (
                    <th key={h} className="text-left px-4 py-2.5 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {events.map(e => (
                  <tr key={e.key} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface)] transition-colors">
                    <td className="px-4 py-2.5"><TxLink hash={e.txHash} /></td>
                    <td className="px-4 py-2.5 tabular font-medium text-[var(--accent)]">#{e.sessionId.toString()}</td>
                    <td className="px-4 py-2.5 tabular">{e.amount !== undefined ? formatUsdcShort(e.amount) : "—"}</td>
                    <td className="px-4 py-2.5">{e.paymentAgent ? <AddrLink address={e.paymentAgent} /> : <span className="text-[var(--subtle)]">—</span>}</td>
                    <td className="px-4 py-2.5">{e.paymentProvider ? <AddrLink address={e.paymentProvider} /> : <span className="text-[var(--subtle)]">—</span>}</td>
                    <td className="px-4 py-2.5 tabular text-[var(--subtle)]">{e.blockNumber.toString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
