# BudgetRail — Implementation Status

Last updated: 2026-10-20 (Part 06 complete)

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

---

## Part 04 (V1 UX: Add Funds, payment recovery, error codes)

Completed 2026-10-20.

### Files changed

| File | Change |
|------|--------|
| `src/pages/Playground.tsx` | UPDATED — 4-step lifecycle stepper; structured error classifier with codes + actions for all failure modes; manual-demo clarification on Pay button; classifyError threaded through all error paths |
| `src/pages/ManageSession.tsx` | UPDATED — Close & Refund explanation panel: who can close, refund math (funded−spent), no-reversal of settled payments, expiry-does-not-auto-refund, irreversibility |
| `src/test/part04.test.ts` | NEW — 30 unit tests: parseUsdcUnits precision, topUpHeadroom cap math, canTopUp gating (closed/expired/full), Close & Refund accounting, isValidAddress, classifyError codes, recovery key uniqueness |

### What is now in the UI

- **Playground 4-step stepper:** Quote issued / Payment broadcast / Payment confirmed / Result delivered — each step is distinct and shows the correct status independently.
- **Structured error codes:** every error path now shows `[ERROR_CODE] user message` + an actionable instruction. Codes: WRONG_AGENT, QUOTE_EXPIRED, INSUFFICIENT_BALANCE, INSUFFICIENT_GAS, SIGNER_MISMATCH, WALLET_REJECTED, WRONG_NETWORK, TX_REVERTED, PROVIDER_UNREACHABLE, INDEXING_DELAY, SIM_FAILED.
- **Manual demo clarification:** Pay button shows "Manual demo mode — you are clicking as the agent. In production the agent wallet calls payForRequest autonomously."
- **Close & Refund explanation:** expanded panel on ManageSession with live refund math, clear settlement irreversibility note, expiry-does-not-auto-refund note.
- **Top-up headroom** was already correct (maxBudget − totalFunded, not maxBudget − availableBalance) — verified and confirmed in tests.

### Manual testnet verification procedure

No transactions are executed automatically. To verify Part 04 behavior manually:

1. Open the Playground page, enter a session ID, paste text, click "Request signed quote".
   - With provider running: should see step 1 turn green.
   - With provider down: should see `[PROVIDER_UNREACHABLE] Provider API is unreachable.` with retry hint.
2. With the WRONG wallet connected (not agent B): should see `[WRONG_AGENT]` error.
3. Let a quote expire (wait past its deadline), then click Pay: should see `[QUOTE_EXPIRED]` with "Request a new quote" action.
4. On Manage Session, expand the Close & Refund section and verify the live refund math matches `totalFunded − totalSpent`.
5. On New Budget, enter your own address as agent B: should see "Same-wallet demo mode (A = B)" guidance.

### Remaining open items

- P0-A: Rotate `QUOTE_SIGNER_PRIVATE_KEY` if git history may have exposed it.
- P0-B: Rotate embedded auth token in git remote URL.
- P0-C: Execute testnet lifecycle manually to fill `evidence/testnet.json`.
- P1-D: All frontend pages still hardcode `arcTestnet` import — deferred to Part 06+.
- P1-E: Get a live hosted app URL and live provider backend URL.

---

## Part 05 (V2 fee design — design-only, no Solidity)

Completed 2026-10-20.

### Files created

| File | Description |
|------|-------------|
| `docs/V2-FEE-SPEC.md` | Full V2 design document — interface, EIP-712 schema, events, frontend/backend/SDK schema, sequence diagrams, V1/V2 compatibility plan, test matrix, threat model, acceptance criteria |

### Key design decisions recorded

- Fee: exactly 50 bps, immutable, computed in contract from `baseAmount` only (OI-2 pending final decision).
- Treasury E: set at deploy, immutable, nonzero. Address TBD — operator must confirm before Part 06.
- `grossUnits = baseUnits + floor(baseUnits * 50 / 10_000)` — consistent across contract/backend/frontend/SDK/agent.
- Zero fee when `baseUnits < 200` — disclosed, no minimum added.
- `PaymentSettledV2` is a distinct event from V1's `PaymentSettled` — no ABI collision.
- EIP-712 domain `version: "2"` — no cross-version replay possible.
- V1 sessions unaffected; no automatic migration.

### Acceptance criteria before Part 06 (Solidity)

- [ ] AC-1: This spec approved by operator.
- [ ] AC-2: Treasury E address selected and ownership verified.
- [ ] AC-3: OI-2 resolved (caller-supplied feeAmount vs contract-computed only).
- [ ] AC-4: OI-5 resolved (stuck direct USDC transfers policy).
- [ ] AC-5 to AC-7: See `docs/V2-FEE-SPEC.md` Section H.

---

## Part 06 (BudgetRailV2.sol + full Foundry test suite)

Completed 2026-10-20.

### Files changed

| File | Change |
|------|--------|
| `contracts/BudgetRailV2.sol` | NEW — 447-line V2 contract: 50 bps immutable fee, atomic two-transfer payout, `via_ir` compatible, full NatDoc |
| `contracts/test/BudgetRailV2.t.sol` | NEW — 57 tests: 54 unit + 3 invariant (256 runs × 128,000 calls each) |
| `foundry.toml` | `via_ir = true` added (required for V2 stack depth) |

### Test results

```
Ran 2 test suites: 57 passed, 0 failed, 0 skipped
  BudgetRailV2Test:      54/54  (unit)
  BudgetRailV2Invariant:  3/3   (invariant, 384,000 fuzzer calls)
```

### Test coverage by category

| Category | Tests | Key assertions |
|----------|-------|----------------|
| FEE arithmetic | FEE-01..09 | $0.05→250 fee, $1→5000 fee, zero-fee boundary 199/200, cap boundary, insufficient gross |
| Authorization | AUTH-01..05 | wrong agent, owner≠agent, A=B mode, non-owner close/fund |
| Signature/replay | SIG-01..12 | wrong key, replay, wrong chainId, wrong contract, V1 domain, tampered treasury/provider, inflated/deflated fee, expired deadline/session, deadline exceeds session |
| Budget/lifecycle | BUD-01..14 | multi-deposit, refund math, zero refund, close after expiry, double close, top-up headroom rule, session isolation, zero params |
| Atomicity/safety | ATOM-01..08 | blocked C, blocked E (C also gets nothing), blocked owner, reentrancy, no fee on create/fund/close, constructor guards |
| Events | EVT-01..02 | PaymentSettledV2 fields, V1≠V2 selector |
| Fuzz | FUZZ-01..04 | fee never rounds up, gross=base+fee always, only agent can pay, conservation invariant |
| Invariants | 3 invariants | totalSpent≤totalFunded, totalFunded≤maxBudget, availableBalance consistent |

### Gas costs (representative)

| Operation | Gas |
|-----------|-----|
| createSession | ~231k |
| fundSession | ~51k |
| payForRequestV2 (base+fee) | ~434k |
| closeSession (with refund) | ~305k |
| computeFee (view) | ~6-7k |

### Remaining open items

- P0-A: Rotate `QUOTE_SIGNER_PRIVATE_KEY` if git history exposure confirmed.
- P0-B: Rotate git remote embedded credential token.
- P0-C: Execute testnet lifecycle manually.
- AC-2: Treasury E address not yet selected — required before V2 deploy.
- AC-3: OI-2 resolved in implementation (contract computes fee independently; caller-supplied feeAmount verified).
- P1-D: Frontend pages still hardcode `arcTestnet` — deferred to Part 07+.
- V2 not yet deployed (awaiting Part 07).
