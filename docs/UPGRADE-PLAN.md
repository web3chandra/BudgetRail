# BudgetRail — Architecture Recovery and Grant-Focused Upgrade Plan

**Status: PRE-APPROVAL REPORT — no files modified.**
Generated: October 17, 2026

---

## 1. Verified Current Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Arc Testnet (5042002)                       │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  BudgetRail.sol  0xf6a13df15ad93c2e2968e1d69c53894a923bda21  │  │
│  │  • createSession(agent,provider,quoteSigner,budget,cap,exp)   │  │
│  │  • fundSession(id, amount)   — after USDC.approve()          │  │
│  │  • payForRequest(id,reqId,reqHash,amount,deadline,sig)        │  │
│  │  • closeSession(id)          — refund to owner               │  │
│  │  • 4 events: SessionCreated, SessionFunded,                  │  │
│  │              PaymentSettled, SessionClosed                   │  │
│  │  USDC_ADDRESS = 0x3600...0000 (immutable, 6-dec ERC-20)      │  │
│  └───────────────────────┬──────────────────────────────────────┘  │
│                          │ safeTransferFrom / safeTransfer          │
│  ┌───────────────────────▼──────────────────────────────────────┐  │
│  │  USDC ERC-20  0x3600000000000000000000000000000000000000      │  │
│  │  6 decimals (ERC-20 view) / 18 decimals (native gas view)    │  │
│  └──────────────────────────────────────────────────────────────┘  │
└──────────────┬────────────────────────────────┬────────────────────┘
               │ wagmi/viem RPC calls            │ viem RPC calls
               │                                 │
┌──────────────▼────────────────┐  ┌─────────────▼──────────────────┐
│  Frontend  (React/Vite/wagmi) │  │  Provider API (Bun/TypeScript) │
│  localhost:5173               │  │  localhost:3001                 │
│                               │  │                                 │
│  5 pages:                     │  │  GET  /api/health               │
│  • Dashboard    — read-only   │  │  POST /api/quotes               │
│  • CreateBudget — 3-step flow │  │  POST /api/fulfill              │
│    (create→approve→fund)      │  │                                 │
│  • Playground   — quote+pay   │  │  Signs EIP-712 PaymentQuote     │
│  • PaymentHistory — getLogs   │  │  Verifies 14 onchain checks     │
│  • ManageSession — close/refund│ │  Returns DocumentInsights       │
│                               │  │                                 │
│  VITE_BUDGET_RAIL_ADDRESS ✓   │  │  QUOTE_SIGNER_PRIVATE_KEY ✓    │
│  VITE_PROVIDER_PAYOUT     ✓   │  │  PROVIDER_PAYOUT_ADDRESS   ✓   │
│  VITE_QUOTE_SIGNER        ✓   │  │  Running on port 3001      ✓   │
│  VITE_PROVIDER_API_URL=/api ✓ │  │  Proxied via Vite /api     ✓   │
└───────────────────────────────┘  └────────────────────────────────┘
               ▲                                 ▲
               │ manual/demo use                 │ AGENT_PRIVATE_KEY
               │                                 │
┌──────────────┴─────────────────────────────────┴──────────────────┐
│  Agent CLI  agent/src/  (Bun/TypeScript, local only)               │
│  • Reads session from contract (getSession)                         │
│  • Requests quote from /api/quotes                                  │
│  • Verifies EIP-712 signature locally                               │
│  • Calls payForRequest via viem WalletClient                        │
│  • Calls /api/fulfill with receipt                                  │
│  Requires: AGENT_PRIVATE_KEY, PROVIDER_API_URL, BUDGET_RAIL_ADDRESS │
└────────────────────────────────────────────────────────────────────┘

Trust boundaries:
  Owner A  ──owns──▶  Session (locked in contract)
  Agent B  ──can only pay from──▶  funded session (contract enforces)
  Provider C  ──receives USDC──▶  immutable per session, passive
  Signer D  ──signs quotes──▶  private key on provider server only
  Frontend  ──never holds──▶  private keys or secrets
  Provider API  ──verifies──▶  14 independent onchain conditions before delivering result
```

---

## 2. Working Features vs Broken Features

### CONFIRMED WORKING (code-verified)

| Feature | Evidence |
|---|---|
| Contract deployed and callable | `USDC_ADDRESS()` and `decimals()` verified via eth_call |
| `createSession` ABI correct | Matches contract source exactly; all 6 args typed correctly |
| `fundSession` ABI correct | Matches contract; uint96 amount type correct |
| `payForRequest` ABI correct | Matches contract; all 6 args including `bytes providerSignature` |
| `closeSession` ABI correct | Single sessionId arg |
| EIP-712 domain | `name="BudgetRail"`, `version="1"`, runtime chainId+verifyingContract; matches contract |
| PaymentQuote typehash | Field order and types match contract `_PAYMENT_QUOTE_TYPEHASH` exactly |
| `simulateContract` preflight | In `useSessionFlow` before every `writeContract`; blocks wallet open on revert |
| 8-state tx machine | `idle→validating→awaiting_signature→submitted→confirming→confirmed/failed/cancelled` |
| SessionCreated event parsing | Receipt logs decoded; sessionId extracted correctly |
| SessionClosed event parsing | Refund amount decoded from receipt |
| localStorage recovery | Draft + pending hashes persisted; `recoverFromChain` reads receipts on mount |
| Provider config guard | `PROVIDER_CONFIGURED` flag; banner shown if zero addresses |
| Provider health endpoint | `/api/health` returns live block, chain config, signer address |
| Provider quote signing | EIP-712 signed with private key D; `requestHash = SHA-256(input)` |
| Provider fulfill verification | 14 independent checks: receipt, PaymentSettled, ERC-20 Transfer, block timestamp, etc. |
| DocumentInsights computation | Fully deterministic; identical input always produces identical output |
| USDC decimal handling | `@/onchain-money` used throughout; no hand-written decimal math in frontend |
| Vite proxy for `/api` | `vite.config.ts` proxies `/api` → `localhost:3001`; no CORS issues |
| All 4 env vars set | `VITE_BUDGET_RAIL_ADDRESS`, `VITE_PROVIDER_PAYOUT`, `VITE_QUOTE_SIGNER`, `VITE_PROVIDER_API_URL` |
| 191 automated tests | Forge 59/59, Provider 64/64, Agent 15/15, Frontend 53/53 — all green |
| lint + typecheck | 0 errors |

### CONFIRMED BROKEN / UNVERIFIED

| Feature | Problem | Severity |
|---|---|---|
| **Full end-to-end flow (browser→chain→provider→result)** | Never executed in a live browser session; all tests use mocked RPC/wallets, not a real wallet connected to Arc Testnet | **CRITICAL** |
| **Playground `payForRequest` — render-body side effect** | Lines 104-128 of `Playground.tsx` call `setFlow` and `void submitFulfill()` directly inside the render function body (not in a `useEffect`). This is the same React anti-pattern that caused stuck UI in `CreateBudget.tsx` and was fixed there but NOT here. On every re-render where `isPaySuccess && flow.stage === "confirming_tx"`, it re-fires `submitFulfill`. | **HIGH** |
| **Playground no `simulateContract` preflight** | `onConfirmPay` calls `payForRequest` directly without simulating first. A revert (expired session, wrong agent, cap exceeded) burns gas with no pre-check. | **HIGH** |
| **Playground isError not consumed** | `payError` is read conditionally inside render body (line 123). Same pattern that caused stuck-UI in `CreateBudget`. It will re-run on every render while the error persists. | **HIGH** |
| **Provider server restarts on sandbox resume** | `/tmp/provider.log` and provider process PID are ephemeral. After sandbox pause/resume the provider is not running and requests to `/api/*` return 502. | **MEDIUM** |
| **Agent CLI: no keepalive or startup script** | `agent/src/demo.ts` requires `AGENT_PRIVATE_KEY` in environment; no funded agent wallet exists. The full agent-driven flow cannot be demo'd without a funded address. | **MEDIUM** |
| **`Playground.tsx` advance logic (line 187)** | `if (payHash && flow.stage === "paying") { setFlow(...) }` runs in render body, not effect. This is a direct state mutation during render. | **MEDIUM** |
| **Dashboard `useRecentPayments` uses default http()** | Line 141: `createPublicClient({ chain, transport: http() })` — no RPC URL. Falls back to viem's hardcoded public endpoint for `arcTestnet`, which may differ from the proxy or rate-limit. | **LOW** |
| **Fulfill response shape** | `Playground.tsx` line 210 reads `data.insights` but `fulfill.ts` returns `{ result, payment }` — the field is `result`, not `insights`. This will always produce `undefined` DocumentInsights on a real fulfill call. | **HIGH — FUNCTIONAL BUG** |
| **Testnet lifecycle not executed** | No real `createSession`, `fundSession`, `payForRequest`, or `closeSession` tx hashes exist in `evidence/testnet.json`. Required for grant submission. | **CRITICAL for grant** |

---

## 3. Confirmed Root Causes and Unresolved Unknowns

### Root causes (confirmed)

**RC1 — Previous tx failures: ZeroAddress revert**
Confirmed across two tx hashes. `VITE_PROVIDER_PAYOUT` and `VITE_QUOTE_SIGNER` were not set. Contract reverts `ZeroAddress()` when either is `address(0)`. Fixed in previous session: both vars are now set.

**RC2 — Playground fulfill field name mismatch**
`Playground.tsx:210` reads `data.insights` but the fulfill handler returns `{ result: DocumentInsights, payment: {...} }`. This means every successful payment would show blank results. This is a one-line fix.

**RC3 — Render-body side effects in Playground**
Three places in `Playground.tsx` call `setFlow`/`submitFulfill` directly in the render function body. This causes double-invocations, potential infinite loops on fast re-renders, and stuck states where the flow never advances correctly. Must be moved to `useEffect`.

**RC4 — No simulateContract in Playground**
Any `payForRequest` revert (wrong agent, expired session, cap exceeded, duplicate requestId) burns gas with no pre-flight error. The CreateBudget hook fixed this pattern but it was not applied to Playground.

### Unresolved unknowns

**U1 — Agent wallet funding**
No funded agent wallet address is configured for a live demo. `payForRequest` must come from agent B's address. Testing the full flow requires either: (a) using the owner's wallet as both A and B (valid for testnet demo), or (b) generating and funding a dedicated agent keypair.

**U2 — Arc Testnet USDC faucet availability**
The "Get test USDC" button in Arc Studio sidebar should provide test USDC. Not verified this session whether the connected wallet has a non-zero USDC balance.

**U3 — Provider process lifecycle after sandbox resume**
The provider server was started manually this session via `execute_background`. After a sandbox pause/resume it will not be running. A startup script or `package.json` `start` script is needed for reliable provider availability.

---

## 4. Proposed Final Architecture

The architecture is correct. No redesign is needed. The three layers (contract, provider, frontend) are properly separated with clear trust boundaries.

The required changes are:

```
Frontend changes only (no contract changes, no new services):
  1. Fix Playground.tsx: render-body effects → useEffect
  2. Fix Playground.tsx: data.insights → data.result
  3. Add simulateContract preflight to Playground onConfirmPay
  4. Add provider server startup script (bun run provider)
  5. Add RepoCheck service to provider (new route + new lib file)
  6. Add RepoCheck tab to Playground page (no new page needed)
  7. Execute live testnet lifecycle manually and record evidence

No new smart contracts needed.
No new databases needed.
No paid external APIs needed (GitHub API is public, OSV API is free).
```

Architecture diagram after changes (same structure, RepoCheck added to provider):

```
Frontend (5 pages, unchanged structure)
  └── Playground: service selector (Document Insights | RepoCheck)
           │
           ▼ /api/quotes?service=repo-check-v1
Provider API (Bun/TypeScript)
  ├── routes/health.ts      (no change)
  ├── routes/quotes.ts      (add service=repo-check-v1 path)
  ├── routes/fulfill.ts     (add service=repo-check-v1 dispatch)
  ├── lib/insights.ts       (unchanged)
  └── lib/repocheck.ts      (NEW — GitHub + OSV, public APIs only)
           │
           ▼ fetch (public, unauthenticated)
  GitHub API (api.github.com) — repo metadata, commit SHA, dependency manifests
  OSV API (api.osv.dev)       — known CVEs for packages (free, no key required)
```

---

## 5. Minimal Code Changes Required

Ordered by impact, smallest first:

### Fix 1 — One-line field name fix (Playground.tsx)
```
Change: const insights = (data as { insights: DocumentInsights }).insights;
To:     const insights = (data as { result: DocumentInsights }).result;
```
Unblocks every real end-to-end test.

### Fix 2 — Move render-body effects to useEffect (Playground.tsx)
Three blocks need extracting into `useEffect` hooks:
- `isPaySuccess && flow.stage === "confirming_tx"` → advance + submitFulfill
- `payError && (flow.stage === "paying" || ...)` → set error state
- `payHash && flow.stage === "paying"` → advance to confirming_tx

### Fix 3 — Add simulateContract preflight to Playground onConfirmPay
Before calling `payForRequest`, simulate with the same args. Show revert reason before wallet opens. Pattern already exists in `useSessionFlow.ts` — replicate it.

### Fix 4 — Provider startup script
Add to `package.json`:
```json
"provider:start": "env $(cat /tmp/provider.env | xargs) bun run provider/src/index.ts"
```
Or better: a `start` script that reads from `.env` natively via Bun's automatic env loading.

### Fix 5 — RepoCheck service (provider side only, no contract change)
New file: `provider/src/lib/repocheck.ts`
New route handling in: `provider/src/routes/quotes.ts` and `provider/src/routes/fulfill.ts`

### Fix 6 — Playground service selector (frontend)
Add a toggle (Document Insights / RepoCheck) and a repo URL + commit SHA input to Playground.tsx. No new page needed.

---

## 6. RepoCheck Integration Design

### What it does
RepoCheck is a paid dependency security scan for public GitHub repositories. Given a repository URL and a commit SHA, it fetches the dependency manifest at that exact commit, queries the OSV API for known vulnerabilities in each dependency, and returns a structured report.

It is NOT a full security audit. The report says exactly: "These packages were present in this manifest at this commit. These CVEs are known against these version ranges per OSV data as of this scan."

### Why this use case works for BudgetRail
A developer asking "are there known CVEs in my dependencies before I deploy?" is a real, motivated workflow. The agent can autonomously scan a repo the developer points it at, pay for the scan, and return evidence of what was found. The result is verifiable: anyone can reproduce it against the same commit SHA and OSV data.

### Request binding
The quote binds: `service`, `repoUrl`, `commitSha`, `manifest` (package.json / requirements.txt / go.mod / etc.), and the `sessionId`. The `requestHash = SHA-256(JSON.stringify({service, repoUrl, commitSha, manifest}))` — same input always produces same hash. A different repo or commit produces a different hash and cannot reuse the same quote.

### Quote schema extension
```typescript
// POST /api/quotes — RepoCheck request body
{
  sessionId: string;
  service: "repo-check-v1";
  input: string;  // JSON: { repoUrl, commitSha, manifest? }
}
```

The provider validates:
1. `repoUrl` matches `^https://github.com/[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$`
2. `commitSha` matches `^[0-9a-f]{40}$`
3. `manifest` is one of: `package.json`, `requirements.txt`, `go.mod`, `Cargo.toml` (or omitted, in which case the provider detects from repo)
4. Repo is public (GitHub API returns 200 without auth token)
5. Commit exists on the repo (GitHub API commit endpoint returns 200)

Price: 50,000 base units ($0.05) — same as Document Insights. The contract enforces `perPaymentCap`; the provider uses the same fixed price.

### Report schema
```typescript
interface RepoCheckReport {
  service:       "repo-check-v1";
  repoUrl:       string;
  commitSha:     string;
  manifest:      string;  // filename found/used
  scannedAt:     string;  // ISO timestamp
  disclaimer:    string;  // "Not a comprehensive audit. OSV data only."
  packageCount:  number;
  findings: Array<{
    package:   string;
    version:   string;
    cveIds:    string[];
    severity:  "critical" | "high" | "medium" | "low" | "unknown";
    summary:   string;
    osvUrl:    string;
  }>;
  findingCounts: { critical: number; high: number; medium: number; low: number };
}
```

### Fulfillment verification
Same 14 checks as Document Insights (receipt, PaymentSettled event, ERC-20 Transfer, block timestamp). The `requestHash` must match `SHA-256(input)` where input is the exact JSON string sent to `/api/quotes`. The provider recomputes the scan from the same `repoUrl`+`commitSha`+`manifest` — deterministic against public data at a fixed commit. The report is idempotent for the same commit SHA.

### Safety constraints
- Only public GitHub repos (no token, no auth)
- `repoUrl` validated against strict regex (no SSRF via redirects or private endpoints)
- `commitSha` must be exactly 40 hex chars (no branch names that could float)
- Dependency manifest is fetched via GitHub raw content endpoint at the exact commit SHA (not HEAD)
- OSV API called with package name and version; no arbitrary URL construction
- Max 200 packages per manifest; excess are truncated with a note
- HTTP timeout: 5s per external call
- No caching of results (each fulfill recomputes from public API — ensures freshness and idempotency)

---

## 7. Security and Regression Test Plan

### Contract tests (existing — all pass, keep as-is)
59 tests in `contracts/test/BudgetRail.t.sol`. Cover all 18 custom errors, 2 invariants, reentrancy, blocklist, EIP-712 vector, and fuzz cases. No changes needed.

### Provider tests (additions needed)
New tests in `provider/test/repocheck.test.ts`:
- RC01: valid public repo + known commit returns report
- RC02: private/nonexistent repo returns 400
- RC03: invalid repoUrl format rejected
- RC04: non-40-char commitSha rejected
- RC05: branch name (not SHA) rejected
- RC06: manifest not found at commit returns 400
- RC07: OSV API timeout handled gracefully (mock)
- RC08: >200 packages truncated correctly
- RC09: requestHash matches SHA-256(JSON.stringify(input))
- RC10: identical input always returns identical report (idempotency)
- RC11: different commitSha produces different requestHash
- RC12: SSRF attempt via repoUrl rejected

### Frontend regression tests (additions needed)
New tests in `src/test/playground.test.ts`:
- PL01: fulfill field name is `result` not `insights` (regression for RC2)
- PL02: `simulateContract` error shown before wallet opens
- PL03: wrong agent wallet shows clear warning
- PL04: retryable 402 from fulfill allows retry without new payment
- PL05: expired quote deadline shown in human-readable form

### End-to-end manual test matrix (required for grant — no mock)
| # | Step | Expected | Evidence |
|---|---|---|---|
| E01 | Connect wallet A, check USDC balance | Non-zero balance shown | Screenshot |
| E02 | Create session (A=B for demo) | SessionCreated tx confirmed, sessionId extracted | Tx hash |
| E03 | Fund session with $0.50 USDC | SessionFunded tx confirmed, balance updated | Tx hash |
| E04 | Request quote (Document Insights) | Signed quote returned with 10-minute deadline | API response |
| E05 | Pay via Playground (agent=owner for demo) | PaymentSettled event in receipt | Tx hash |
| E06 | Fulfill succeeds | DocumentInsights result shown with tx link | Screenshot |
| E07 | Request + pay RepoCheck | Same flow, repo report returned | Tx hash + screenshot |
| E08 | Dashboard shows payment history | PaymentSettled event visible | Screenshot |
| E09 | Close session | SessionClosed tx, refund amount correct | Tx hash |
| E10 | Dashboard shows zero available balance after close | Available = $0.00 | Screenshot |

All tx hashes go into `evidence/testnet.json`.

---

## 8. Ordered Implementation Phases

### Phase 0 — Pre-flight (do first, unblocks everything else)
1. Fix `Playground.tsx` render-body effects → `useEffect` (Fix 2)
2. Fix `Playground.tsx` field name `data.insights` → `data.result` (Fix 1)
3. Add `simulateContract` preflight to `Playground.tsx` (Fix 3)
4. Add provider startup to `package.json` so it survives sandbox resume (Fix 4)
5. Run `bun run check` and forge test — confirm still green

**Estimated: 1 session. Unblocks the first live testnet run.**

### Phase 1 — First live testnet run
6. Operator: connect wallet, get test USDC from Arc Studio sidebar
7. Create session with owner=agent (same wallet for demo simplicity)
8. Fund session $0.50
9. Request quote + pay via Playground
10. Verify DocumentInsights result appears with tx link
11. Close session, verify refund

Record all tx hashes in `evidence/testnet.json`. This produces the 30% USDC movement evidence.

**Estimated: 1 session (interactive). Required before any grant submission.**

### Phase 2 — RepoCheck service
12. Implement `provider/src/lib/repocheck.ts` (GitHub + OSV fetch, report schema)
13. Add `repo-check-v1` path to `provider/src/routes/quotes.ts`
14. Add `repo-check-v1` dispatch to `provider/src/routes/fulfill.ts`
15. Add provider tests RC01–RC12
16. Add RepoCheck tab to `Playground.tsx`
17. Run all tests

**Estimated: 1–2 sessions.**

### Phase 3 — UX polish for demo clarity
18. Dashboard: show "Document Insights" and "RepoCheck" labels in payment history
19. Playground: show clear "Agent ran this autonomously" vs "Owner paid manually" distinction
20. Session detail: show `requestHash` ↔ input linkage ("This payment bought scan of commit abc123")
21. Add a one-page "What is BudgetRail?" landing section to Dashboard (3 bullets, no marketing)

**Estimated: 1 session.**

### Phase 4 — Grant packaging
22. Complete `evidence/testnet.json` with all real tx hashes
23. Update `docs/MASTER.md` with RepoCheck documentation
24. Record a 3-minute screen recording walkthrough
25. Push to GitHub
26. Deploy to Hugging Face (via Arc Studio Integrations)

---

## 9. Mainnet and Grant-Readiness Criteria

### Grant scoring map

| Criterion | Weight | What is needed | Current status |
|---|---|---|---|
| Real Arc mainnet USDC movement | 30% | At minimum: one `createSession` + `fundSession` + `payForRequest` + `closeSession` tx chain on mainnet | NOT DONE. Testnet lifecycle not yet executed either. Requires Phase 1 first. |
| Arc Studio usage | 25% | Studio Project URL, evidence that contract/tests/frontend were generated in Studio | Exists (this Studio session). Needs public GitHub repo to link from. |
| Working application | 25% | Live hosted app where a judge can connect a wallet, see the flow, and verify it on explorer | NOT DONE. Needs Phase 0–1 and a Hugging Face deploy. |
| Future potential | 20% | Clear explanation of how other agents/providers could use the same system | EXISTS in docs/MASTER.md Section 19 and this plan's RepoCheck design. |

### Required evidence checklist

- [ ] Arc Studio Project URL (copy from browser URL bar after pushing to GitHub from Studio)
- [ ] Public GitHub repo URL
- [ ] Public hosted app URL (Hugging Face Space after deploy)
- [ ] Arc Testnet contract: `0xf6a13df15ad93c2e2968e1d69c53894a923bda21` + explorer link
- [ ] Arc Testnet tx hashes: `createSession`, `fundSession`, `payForRequest`, `closeSession` (from `evidence/testnet.json`)
- [ ] Arc Mainnet contract address (requires independent deploy by operator — see `docs/DEPLOYMENT.md`)
- [ ] Arc Mainnet tx hashes: same lifecycle executed on mainnet (requires operator with real USDC)
- [ ] Test output screenshot: 191/191 green
- [ ] 3-minute walkthrough recording showing: wallet connect → create session → pay → result → close/refund

### Mainnet prerequisites (NOT to be done without explicit approval)

Before any mainnet step:
1. Phase 0 and Phase 1 fully executed on testnet (all 10 E0x steps verified)
2. Phase 2 complete (RepoCheck working on testnet)
3. Independent contract review by a third party (not this system)
4. Operator has Arc Mainnet USDC for gas and session funding
5. `BUDGET_RAIL_MAINNET_ADDRESS` set after independent mainnet deploy

The contract source and ABI are identical for testnet and mainnet. Only the constructor arg (USDC address) and the env vars change. Both are `0x3600000000000000000000000000000000000000`.

---

## STOP — No files modified. Awaiting approval to proceed.

Recommended first action: **Approve Phase 0** (Fixes 1–4 above).
This unblocks the first real testnet run and all subsequent work.
