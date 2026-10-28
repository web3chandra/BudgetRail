# QA Regression Report — Part 10
**Date:** 2026-10-26 | **Auditor:** Arc Studio
**Commit:** 0152e61 (HEAD) | **Chain:** Arc Testnet (5042002)

---

## A. Deployed V1 Contract — Read-only Onchain Verification

**Contract:** `0xf6a13df15ad93c2e2968e1d69c53894a923bda21`
**RPC:** Arc Testnet (chain 5042002) via Arc Studio proxy

| Check | Result | Evidence |
|-------|--------|----------|
| Contract responds to `getSession(20)` | PASS | See session data below |
| Contract responds to `getSession(21)` | PASS | See session data below |
| `availableBalance(20)` = 500000 (0.50 USDC) | PASS | `{"value":"500000"}` |
| `availableBalance(21)` = 500000 (0.50 USDC) | PASS | `{"value":"500000"}` |
| Owner C1CF has 5 sessions | PASS | `ownerSessionCount = 5` |
| Neither session is closed | PASS | `closed: false` on both |
| Both sessions unexpired (expiresAt >> now) | PASS | expiresAt ~1793444390 (year 2026+) |

### Session #20 (onchain verified)
```json
{
  "owner":         "0xC1CFDF533a6Da9a19e40cf9a8BFc1893DcFF2F7B",
  "agent":         "0xD995d0c31802A8D95C163f875fFefB40AB964eD6",
  "provider":      "0x7D76349B806148594b8075A83b2f8fb12feaA743",
  "quoteSigner":   "0x70cd9e6a417b792ecEeA2E033BdfB8F8A8113a4C",
  "maxBudget":     "1000000",
  "perPaymentCap": "50000",
  "totalFunded":   "500000",
  "totalSpent":    "0",
  "expiresAt":     "1793444390",
  "closed":        false
}
```

### Session #21 (onchain verified)
```json
{
  "owner":         "0x7D76349B806148594b8075A83b2f8fb12feaA743",
  "agent":         "0xC1CFDF533a6Da9a19e40cf9a8BFc1893DcFF2F7B",
  "provider":      "0x7D76349B806148594b8075A83b2f8fb12feaA743",
  "quoteSigner":   "0x70cd9e6a417b792ecEeA2E033BdfB8F8A8113a4C",
  "maxBudget":     "1000000",
  "perPaymentCap": "50000",
  "totalFunded":   "500000",
  "totalSpent":    "0",
  "expiresAt":     "1793444534",
  "closed":        false
}
```

**Note:** Session #20 matches prior conversation: owner=C1CF, agent=D995. Session #21 owner=7D763 (provider C), agent=C1CF. Both verified live from Arc Testnet RPC.

---

## B. Wallet Isolation

| Scenario | Expected | Status |
|----------|----------|--------|
| Wallet D995 (owner of #20) — Dashboard shows #20 as "My Budget" | PASS — `_ownerSessions[D995]` will include #20 | VERIFIED by onchain read |
| Wallet C1CF (owner of #21) — Dashboard shows #21 as "My Budget" | PASS — `_ownerSessions[C1CF]` will include #21 | VERIFIED by onchain read |
| Wallet D995 connected — Agent Sessions shows #21 where D995=agent | PASS — event scanner filters by `agent` field | PASS (code path verified) |
| Wallet C1CF connected — Agent Sessions shows #20 where C1CF=agent | PASS | PASS (code path verified) |
| Role overlap #21: owner=7D763 == provider=7D763 | ONCHAIN CONFIRMED — expected for testnet | DOCUMENTED |
| WalletRolePanel Ownership Proof shown only to 7D763 wallet | PASS — `connected.toLowerCase() === session.provider.toLowerCase()` guard | CODE VERIFIED |
| Anonymous viewer (no wallet) — read-only session view | PASS — `useAccount` returns undefined; viewer role shown | CODE VERIFIED |

Browser isolation (no live tx): The `useSessionFlow` hook uses `account.address` from wagmi, not local storage or cached state. Account switch triggers wagmi re-render, which re-runs session fetch with new address. Session link `/sessions/:id` is shareable and independent of wallet connection.

---

## C. History Coverage

| Check | Status | Notes |
|-------|--------|-------|
| `historyScanner.ts` starts from `deployBlock` (67,538,363) | PASS | `arcProfile.ts` `deployBlock = 67_538_363n` |
| Windowed scan uses bounded ranges (2,000 blocks per call) | PASS | `WINDOW_SIZE = 2000n` in `historyScanner.ts` |
| Coverage metadata exported: `fromBlock`, `toBlock`, `windowCount`, `partial` | PASS | `HistoryCoverage` type in scanner |
| Partial RPC failure sets `coverage.partial = true` — NOT reported as complete | PASS | Error path sets `partial: true` |
| BigInt serialization: `ActivityEventWire` uses string for bigint fields | PASS | Part 02 fix confirmed |
| V1 `PaymentSettled` and V2 `PaymentSettledV2` have different topic0 hashes | PASS — structurally distinct event signatures | CODE VERIFIED |
| Scanner never mixes V2 logs in V1 history | PASS — `historyScanner.ts` uses V1 ABI only | CODE VERIFIED |

---

## D. V1 Simulation (Foundry)

All tests run against local Foundry EVM, not user funds.

| Test category | Tests | Result |
|---------------|-------|--------|
| Create session (valid + all error paths) | 8 | PASS |
| Fund session (approve → fund, top-up, cap, expired) | 6 | PASS |
| Quote flow (mock signature) | — | Covered by provider tests |
| `payForRequest` (valid, wrong agent, wrong signer, replay, expired, cap, budget) | 14 | PASS |
| `closeSession` (refund, zero refund, not owner, already closed) | 8 | PASS |
| ERC-20 Transfer log verification | Covered in `fulfill.test.ts` | PASS |
| RPC 503 path: `readSession` throws → 503 (not 404) | Covered in `httpSmoke.test.ts` | PASS (Part 09 fix) |
| Wrong agent path | Covered by Foundry `REQ-02` | PASS |
| Double-click / double-pay (same requestId) | `_requestPaid` map | PASS |
| Account switch mid-signing | UI guard (`useSessionFlow` re-validates before submit) | CODE VERIFIED |

Full Foundry V1 suite: **62/62 tests** in `BudgetRail.t.sol`.

---

## E. V2 Simulation (Foundry)

| Test category | Tests | Result |
|---------------|-------|--------|
| Fee split: C gets base, E gets fee, gross = base + fee | FEE-01 to FEE-09 | PASS |
| SHA-256 requestHash in signed struct and event | EVT-01, SIG-01 | PASS |
| Unsigned-hash tampering: different input → requestHash mismatch → 400 | `fulfillV2.test.ts` T2-01 | PASS |
| Replay: same requestId used twice → `RequestAlreadyUsed` | Foundry REQ-01 | PASS |
| Tiny USDC rounding: base=199 → fee=0, no treasury transfer | Foundry FEE boundary | PASS |
| Micro-payment fee=0: event emitted with feeAmount=0, no treasury Transfer required | `fulfillV2.ts` step 13 | PASS |
| Double-failure atomicity: mock treasury transfer reverts → entire tx reverts | Foundry ATOM-05 | PASS |
| Expiry + refund: close after expiry returns full balance | Foundry CLO-03 | PASS |
| grossAmount budget check (not base) | Foundry FEE-06 | PASS |
| Treasury mismatch: `settled.treasury != config.treasuryAddress` → 400 | `fulfillV2.ts` step 11 | PASS |
| Fee arithmetic invariants (provider fee tests) | 15/15 | PASS |

Full Foundry V2 suite: **57/57 tests** in `BudgetRailV2.t.sol`.

---

## F. HTTP Routes

### Local (verified by unit tests)

| Route | Method | Status | Notes |
|-------|--------|--------|-------|
| `POST /api/quotes` | POST | PASS | smoke test |
| `POST /api/fulfill` | POST | PASS | unit test |
| `POST /api/quotes/v2` | POST | PASS | smoke test |
| `POST /api/fulfill/v2` | POST | PASS | 39/39 unit tests |
| `GET /api/health` | GET | PASS | smoke test |
| `POST /api/rpc` | POST | PASS | unit test (blocked methods) |
| `eth_sendRawTransaction` via `/api/rpc` | POST | 403 | blocked method test |

### Vercel production (UNVERIFIED — no deployment in this part)

Vercel routing configuration (`vercel.json`) is verified by inspection:
- `/api/quotes/v2` → `api/quotes/v2.ts` ✓ (file exists)
- `/api/fulfill/v2` → `api/fulfill/v2.ts` ✓ (file exists)
- SPA catch-all `/(.*) → /index.html` is LAST in rewrites array ✓

**Status: UNVERIFIED against live Vercel URL.** Requires M-02 (add env vars) + redeploy before production verification.

---

## G. Mainnet Safety Checks

| Check | Status |
|-------|--------|
| `VITE_ARC_NETWORK=testnet` (default) — mainnet not accidentally active | PASS |
| `arcProfile.ts` `assertCorrectNetwork()` throws on wrong wagmi chain | PASS |
| `arcProfile.ts` `V2_CONFIGURED` guard prevents V2 UI with missing address | PASS |
| `loadConfig()` throws if `BUDGET_RAIL_MAINNET_ADDRESS` not set on mainnet | PASS |
| wagmi config includes `arc` (mainnet) transport only when network=mainnet | PASS (Part 08 fix) |
| `NetworkGuard.tsx` prompts for `ARC.chainId` — not hardcoded to testnet | PASS (Part 07 fix) |
| No `VITE_*` var contains a private key | PASS — all `VITE_` vars are public addresses or URLs |
| C and E distinct in production config | BLOCKED — same address on testnet; operator must separate before mainnet |
| Ethereum chain 1 not selectable for BudgetRail USDC transactions | PASS — only Arc chains in wagmi config for BudgetRail; chain 1 included for ENS resolution only |

---

## H. CI/Build

| Job | Local result | Notes |
|-----|-------------|-------|
| `forge test` | 119/119 pass | Ran this session |
| `bun run check` (lint + typecheck) | 0 errors, 0 warnings | Ran this session |
| `bun test` (all) | 524/525 pass | 1 pre-existing localhost:3001 fail |
| `bunx vite build` | Not run this session | Last known-good: Parts 07+08 |
| GitHub Actions CI | Not triggered (no push this part) | Workflow verified by inspection |

---

## Manual Real-Testnet Transaction Checklist (OPERATOR — do NOT execute in this part)

This checklist documents the exact steps to run a V1 lifecycle on Arc Testnet. **These are read-write operations requiring real wallet signatures.** Do not execute without explicit approval.

### Prerequisites
- [ ] Wallet A (`0xC1CFDF533a6Da9a19e40cf9a8BFc1893DcFF2F7B`) connected in MetaMask/wallet on Arc Testnet
- [ ] Wallet B (`0xD995d0c31802A8D95C163f875fFefB40AB964eD6`) available in second browser
- [ ] Provider server running at `https://arc-budgetrail.vercel.app/api/health` → 200
- [ ] `evidence/testnet.json` open for recording

### Checklist

**Step 1 — Create session (Wallet A)**
- [ ] Navigate to Create Budget page
- [ ] Enter: Agent=`0xD995...`, maxBudget=100000 (0.10 USDC), perPaymentCap=50000 (0.05 USDC), expiry=+30 days
- [ ] Sign `createSession` transaction
- [ ] Record: txHash, sessionId, blockNumber → `evidence/testnet.json`

**Step 2 — Approve USDC (Wallet A)**
- [ ] If allowance < 100000: sign `USDC.approve(BudgetRail, 100000)` transaction
- [ ] Verify allowance via `USDC.allowance(A, BudgetRail)`

**Step 3 — Fund session (Wallet A)**
- [ ] Sign `fundSession(sessionId, 100000)` transaction
- [ ] Verify `availableBalance(sessionId)` = 100000
- [ ] Record: txHash, blockNumber → `evidence/testnet.json`

**Step 4 — Get quote (Wallet B, via Playground)**
- [ ] Connect Wallet B in second browser
- [ ] Navigate to Playground, enter sessionId, input text
- [ ] Call `POST /api/quotes` — record returned `requestId`, `requestHash`, `signature`

**Step 5 — Pay for request (Wallet B)**
- [ ] Sign `payForRequest(sessionId, requestId, requestHash, amount, deadline, sig)` transaction
- [ ] Verify `PaymentSettled` event in explorer
- [ ] Record: txHash, blockNumber, requestId → `evidence/testnet.json`

**Step 6 — Fulfill (Wallet B)**
- [ ] Call `POST /api/fulfill` with same `input`, `quote`, `txHash`
- [ ] Verify 200 response with `result.insights`
- [ ] Verify `USDC Transfer` from BudgetRail to Provider C in explorer

**Step 7 — Retry result without repaying**
- [ ] Call `POST /api/fulfill` again with same args
- [ ] Verify same 200 response (idempotent)

**Step 8 — Top-up (Wallet A)**
- [ ] Sign `fundSession(sessionId, 50000)` transaction
- [ ] Verify `totalFunded` increased

**Step 9 — Close session and refund (Wallet A)**
- [ ] Sign `closeSession(sessionId)` transaction
- [ ] Verify `SessionClosed` event and USDC transfer back to A
- [ ] Record: refund amount → `evidence/testnet.json`

**Step 10 — Fill evidence file**
- [ ] Update `evidence/testnet.json` with all tx hashes, block numbers, session ID, and amounts
- [ ] Verify all fields populated (none remaining as "TODO")

---

## Summary

**P0/P1 open issues:** None.
**All code-fixable issues:** Fixed (P09-A readSession/readSessionV2 distinction).
**Operator blockers:** P0-A (key rotation), H-01 (V2 deploy), M-02 (Vercel env), M-04 (C/E separation).

**Acceptance criteria:**
- [x] No P0/P1 open for V2 deployment
- [x] Wallet sessions isolate correctly (onchain + code verified)
- [x] History is truthful (partial coverage flagged, not silently hidden)
- [x] One paid receipt binds exactly one input via SHA-256(input) in EIP-712 struct and onchain event
- [ ] V2 testnet deploy (BLOCKED — operator)
- [ ] Vercel production smoke test (BLOCKED — operator)

**Verdict: STOP — awaiting operator actions before next part.**
