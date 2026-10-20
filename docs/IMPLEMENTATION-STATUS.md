# BudgetRail — Implementation Status

Last updated: 2026-10-20 (Part 03 complete)

---

## Part 01 (audit only — no code changes)

Completed 2026-10-20. Delivered `docs/FINAL-BASELINE.md`.

Key findings:
- V1 contract, ABI, EIP-712, and provider logic all verified correct.
- Three confirmed bugs: (1) SDK silent window skip, (2) PaymentHistory only scanned PaymentSettled, (3) all pages hardcode `arcTestnet`.
- Zero onchain lifecycle evidence recorded (evidence/testnet.json all null).

---

## Part 02 (history data model, SDK, scanner reliability)

Completed 2026-10-20.

### Files changed

| File | Change |
|------|--------|
| `src/lib/historyScanner.ts` | NEW — unified all-event scanner |
| `src/pages/PaymentHistory.tsx` | REWRITTEN — all 4 events, tabs, coverage badge |
| `src/pages/Dashboard.tsx` | FIXED — replaced unbounded getLogs with `scanRecentEvents` |
| `packages/sdk/src/read.ts` | FIXED — retry + explicit failures + dedup key |
| `packages/sdk/src/types.ts` | EXTENDED — `CoverageMetadata`, `FailedRange`, `IncompleteHistoryError` |
| `packages/sdk/src/index.ts` | EXTENDED — exports for new types |
| `src/test/historyScanner.test.ts` | NEW — unit tests |

### What was fixed

**P1-A (SDK silent window skip) — FIXED**
`packages/sdk/src/read.ts` `scanPaymentSettledEvents`: removed the silent `catch { continue }` block. Each window now retries up to 3× with exponential backoff (800ms base, doubles per attempt). On final failure the range is recorded in `coverage.failedRanges`. If any range fails, `IncompleteHistoryError` is thrown carrying `partialResults` and `coverage`. Callers can no longer receive silent partial data.

**P1-B (PaymentHistory only showed PaymentSettled) — FIXED**
`src/pages/PaymentHistory.tsx` completely rewritten. Now fetches all four event types via `historyScanner.scanAllEvents`. Tab bar: All / Payments / Deposits / Refunds. Coverage badge shows: Full (green), Partial (grey with block range), or Failed windows (red). Cancellable via AbortController. 5-minute localStorage checkpoint so repeat loads only scan new blocks. Sort: newest-first in UI (ascending internally).

**P1-C (Dashboard unbounded getLogs) — FIXED**
`src/pages/Dashboard.tsx` `useRecentPayments` now calls `scanRecentEvents(address, 3)` — three windows of 9,999 blocks each (~30k blocks). Uses the same windowed + retry scanner. Returns `ActivityEvent[]` with the correct `key`, `paymentAgent`, `paymentProvider` fields. No single unbounded getLogs call anywhere in the frontend.

**SDK dedup key — FIXED**
Old dedup key was `requestId` alone — two logs with different `requestId` but same `txHash+logIndex` would both be included; a log could also be deduplicated incorrectly across chains if `requestId` collided. New key: `${txHash}-${logIndex}` (frontend) and same in SDK.

### historyScanner.ts guarantees

- **Never silent failure**: every failed window is in `failedRanges`; `isComplete` is false; error surfaces to UI.
- **Bounded concurrency**: 2 getLogs calls in flight at once.
- **Explicit coverage**: `CoverageResult` always includes `scannedFrom`, `scannedTo`, `chainHead`, `isComplete`, `failedRanges`.
- **Resumable checkpoint**: 5-min versioned localStorage cache keyed by `chainId+contract+fromBlock`.
- **Correct sort**: ascending `blockNumber + logIndex` internally; UI shows newest-first by reversing.
- **Correct dedup**: `chainId-contractAddress-txHash-logIndex`.
- **Cancellable**: `AbortController` signal propagates through all windows.
- **No double-count**: only reads BudgetRail contract logs — no USDC contract, no Approval events, no native gas.

### Unit tests added (`src/test/historyScanner.test.ts`)

- `filterByTab`: all/payments/deposits/refunds isolation
- `eventTypeLabel`: all 4 labels
- `eventTypeColor`: non-empty for all 4 types
- Dedup key: `txHash-logIndex`, not `requestId`
- Sort order: ascending block + logIndex tiebreak; newest-first reverse
- Checkpoint round-trip: bigint fields survive JSON serialization
- Window boundary arithmetic: no gaps, no overlaps, exact `[from, to]`
- Single-block range: exactly one window
- Deploy block boundary: `fromBlock = DEPLOY_BLOCK_TESTNET` is the first window

---

## Known remaining items (deferred to future parts)

### P0
- P0-A: Rotate `QUOTE_SIGNER_PRIVATE_KEY` if any public exposure occurred via prior ZIP
- P0-B: Git remote URL contains embedded auth token — rotate before next push
- P0-C: No testnet lifecycle transactions recorded — `evidence/testnet.json` all null

### P1
- P1-D: Wallet C and D ownership unverified (addresses are zero in env.example.txt)
- P1-E: No public app URL or hosted provider backend

### P2
- All 5 frontend pages still import `arcTestnet` directly from `viem/chains` instead of `ARC.chainId` from `arcProfile.ts`
- `src/config.ts` (wagmi config) still hardcodes `arcTestnet` directly
- CI workflow deferred (requires workflow PAT scope — commit `7dea0e5`)
- Rate limiter in `provider/src/lib/ratelimit.ts` is in-memory (resets on restart)

---

## Testnet evidence

Contract: `0xf6a13df15ad93c2e2968e1d69c53894a923bda21` (Arc Testnet, chain 5042002)
Deploy block: `67538363`
Lifecycle transactions: **none recorded** — `evidence/testnet.json` lifecycle fields are all null.
Mainnet: **not deployed**.

Provider payout wallet C: `0x7D76349B806148594b8075A83b2f8fb12feaA743` (set by user 2026-10-20, not yet in .env)
Quote signer D: unknown — lives in `provider/.env` (gitignored).

---

## Part 03 (wallet role clarity, payout ownership, revenue security)

Completed 2026-10-20.

### Files changed

| File | Change |
|------|--------|
| `src/components/WalletRolePanel.tsx` | NEW — "Who gets paid?" panel: A/B/C/D/V/E roles, copyable addresses, explorer links, source labels, signer rotation runbook, V1/V2 treasury note |
| `src/components/OwnershipProof.tsx` | NEW — sign-a-nonce ownership verification for C and D; local ecrecover only; no transactions, no external server |
| `src/pages/CreateBudget.tsx` | UPDATED — WalletRolePanel added above form; A=B same-wallet wizard guidance added below agent field |
| `src/pages/ManageSession.tsx` | UPDATED — WalletRolePanel + OwnershipProof C added after session parameters card |
| `src/test/walletRoles.test.ts` | NEW — 17 unit tests: signer mismatch, A=B, provider configured, V1/V2 fee model, proof message structure, role permission boundaries |

### What is now in the UI

- **"Who gets paid?"** panel on New Budget and Manage Session (collapsed by default, expandable).
  Shows roles A/B/C/D/V with full addresses, copy buttons, explorer links, source label ("session chain state" vs "backend public config"), and permission description.
- **V1 vs V2 note** for role E: V1 = no treasury; V2 = 0.5% immediate on each payment to E, no admin-withdraw needed.
- **Signer mismatch warning** embedded in the role panel and in the existing ManageSession banner. Signer rotation runbook is inline (expandable).
- **A=B wizard mode** tip on CreateBudget when the agent address matches the connected wallet.
- **Ownership proof** on ManageSession for provider C: sign a human-readable message locally, verify by ecrecover, no server, no transaction.
- All "unverified" labels shown when ownership cannot be proven from connected wallet alone.

### Operator required public config

To activate the role panel correctly, set in `.env`:
- `VITE_PROVIDER_PAYOUT=0x7D76349B806148594b8075A83b2f8fb12feaA743` (Role C — confirmed address)
- `VITE_QUOTE_SIGNER=<D public address from provider/.env>` (Role D — derive from private key)

### Remaining open items from Part 01/02/03

- P0-A: Rotate `QUOTE_SIGNER_PRIVATE_KEY` if git history may have exposed it.
- P0-B: Rotate embedded auth token in git remote URL.
- P0-C: Execute testnet lifecycle manually to fill `evidence/testnet.json`.
- P1-E: Get a live hosted app URL and live provider backend URL.
- All frontend pages still hardcode `arcTestnet` import (P1-D from Part 01) — deferred to Part 04+.
