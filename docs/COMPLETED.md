# COMPLETED — All Work Done in Arc Studio

Last updated: 2026-10-29
Test baseline: 524/525 bun pass · 119/119 Foundry pass · 0 lint errors · 0 typecheck errors

---

## Parts 01–02: Foundation, SPA Routing, Session UX

- SPA routing fix via `public/vercel.json` (shared session links work across browsers)
- `Dashboard.tsx` — `useAgentSessions` with full 8-input canonical ABI, AbortController, generation counter
- `src/lib/historyScanner.ts` — BigInt serialization fix for `ActivityEventWire`
- `ManageSession.tsx` — `prevSessionRef`, `isHardLoading`, stale time, RPC caveat banner
- `WalletRolePanel.tsx` — Ownership Proof panel only shown when connected wallet IS Provider C
- `api/rpc.ts` — three-tier RPC resolution (sandbox proxy → `ARC_TESTNET_RPC_URL` → `VITE_ARC_TESTNET_RPC`), 10s timeout, 503 with "no funds were spent" message
- `docs/ARCHITECTURE.md` — all 10 scenarios, every role, every money flow
- `env.example.txt` — exact values/placeholders with comments; Vercel vs local-only sections
- `src/test/part01part02Regression.test.ts` — 35 regression tests, all pass

---

## Part 03: V1 Audit — No Code Changes Needed

- Verified `provider/src/routes/quotes.ts`, `fulfill.ts`, Playground UI all correct
- Fixed 3 documentation errors in `docs/ARCHITECTURE.md`: `pay()` → `payForRequest()`

---

## Part 04: P0 Security Fix — requestHash Binding

**Root cause:** V2 `PaymentQuoteV2` EIP-712 typehash was missing `requestHash`, meaning a provider could fulfill a different document against an existing receipt.

**Fixed across every layer:**
- `contracts/BudgetRailV2.sol` — added `bytes32 requestHash` to `payForRequestV2` params, EIP-712 struct, and `PaymentSettledV2` event
- `provider/src/lib/eip712.ts` — added `requestHash` to `PAYMENT_QUOTE_V2_TYPES` and `signQuoteV2`
- `provider/src/routes/quotesV2.ts` — passes `requestHash` to `signQuoteV2`
- `provider/src/routes/fulfillV2.ts` — verifies `requestHash` from the onchain event (not the unsigned quote)
- `provider/src/lib/onchain.ts` — updated V2 ABI and `DecodedPaymentSettledV2` interface
- `packages/sdk/src/abi.ts` — corrected V2 parameter order and field names
- `packages/sdk/src/types.ts` — `SignedQuoteV2`: renamed `quoteDeadline` → `deadline`, added `requestHash`
- `packages/sdk/src/pay.ts` — corrected arg order for `simulatePayV2` / `submitPaymentV2`
- `packages/sdk/src/read.ts` — updated `decodePaymentSettledV2Log`
- `packages/sdk/src/quote.ts` — fixed `verifyQuoteV2` domain name (`"BudgetRail"` not `"BudgetRailV2"`) and field order
- `contracts/test/BudgetRailV2.t.sol` — updated `QUOTE_V2_TYPEHASH`, all `_sign`/`_signBase`/`_pay` helpers, 26+ call sites, EVT-01 decode
- `provider/test/fulfillV2.test.ts` — added `REQUEST_HASH` constant, updated fixtures
- **119/119 Foundry tests pass after fix**

---

## Part 05: V2 0.5% Fee Verification + Treasury Guard

- **Confirmed correct:** FEE_BPS=50/10000, atomicity via SafeERC20+nonReentrant, gross budget/cap in contract
- `provider/test/feeArithmetic.test.ts` — 15 new tests: boundary (199/200/201), rounding, large values, additive model
- `provider/src/lib/config.ts` — added C==E mainnet hard-fail guard at startup (testnet unaffected)
- `src/pages/Playground.tsx` — V2 confirm modal now shows "Provider base (C) / Platform fee 0.5% (E) / Gross charge" explicitly

---

## Part 06: API Routes, RPC 503, Provider Signer Safety

- `api/rpc.ts` — blocked `eth_sendRawTransaction` / `eth_sendTransaction` (HTTP 403); added one retry with 600ms backoff on upstream 429/503
- `provider/src/lib/config.ts` — `QUOTE_SIGNER_PRIVATE_KEY` format validated at startup (0x-prefixed 64-hex regex); bad key throws at cold start not mid-request
- `vercel.json` — fixed V2 rewrite destinations (were pointing at `/api/quotesV2` which didn't exist)
- `provider/test/httpSmoke.test.ts` — 22 new smoke tests covering health, V1/V2 route correctness, V2 disabled-503, config validation

---

## Part 07: Wallet Role UX, Network Profile Wiring

- **Root cause:** `arcTestnet.id` was hardcoded in 6 files — on a mainnet build the network guard demanded chain 5042002 and every tx targeted the wrong chain
- `src/components/NetworkGuard.tsx` — now reads `ARC.chainId` and `ARC.chainName` from the central profile
- `src/hooks/useSessionFlow.ts` — `CHAIN_ID = ARC.chainId` (was `arcTestnet.id`)
- `src/pages/CreateBudget.tsx`, `ManageSession.tsx`, `Dashboard.tsx`, `Playground.tsx` — all replaced `arcTestnet.id` with `ARC.chainId`; hardcoded "Arc Testnet" strings replaced with `ARC.chainName`
- 54 new regression tests added

---

## Part 08: Network Isolation, SDK, wagmi Config

- `src/config.ts` — fixed `arcMainnet` import (correct export from `viem/chains` is `arc`); Arc Mainnet now properly registered as a wagmi transport for mainnet builds
- `examples/agent-app/` — confirmed full runnable Bun dry-run demo already present
- Network isolation tests added covering testnet/mainnet profile switching, `assertCorrectNetwork`, fail-closed behavior

---

## Part 09: Deep Security Audit + CI

- **No P0/P1 code defects found** — all previously identified issues were fixed in Parts 04–08
- `provider/src/lib/onchain.ts` — fixed `readSession`/`readSessionV2`: now throws on RPC error instead of returning `null` (callers now correctly get 503 instead of 404 on RPC failure)
- `.github/workflows/ci.yml` — added `secret-scan` (gitleaks) and `abi-consistency` (forge inspect) jobs; corrected stale test count comments
- `docs/SECURITY-AUDIT-PART09.md` — full security audit report written
- Git history verified: no `.env` files ever committed

---

## Part 10: QA Regression + Live Chain Verification

- **Live onchain reads confirmed:**
  - Session #20: owner=0xC1CF, agent=0xD995, available=500000 (0.50 USDC), open
  - Session #21: owner=0x7D763, agent=0xC1CF, available=500000 (0.50 USDC), open
  - V1 contract `0xf6a13df15ad93c2e2968e1d69c53894a923bda21` healthy on Arc Testnet
- `docs/QA-REGRESSION-REPORT.md` — full per-test evidence with PASS/FAIL/BLOCKED status
- Manual testnet tx checklist written for operator use

---

## Part 11: Mainnet GO/NO-GO Preflight

- `docs/GO-NOGO-MATRIX.md` — updated with current test counts, all findings, critical path timeline; verdict: **NO-GO** (5 operator actions pending)
- `docs/MAINNET-DEPLOY-RUNBOOK.md` — fixed critical bug: `payForRequestV2` call was missing `requestHash` parameter
- `evidence/mainnet.json` — updated with SHA-256 source hashes and ABI selector tables
- `docs/VIDEO-STORYBOARD.md` — 8-scene, 2:30 demo script written
- `docs/PUBLIC-RELEASE-CHECKLIST.md` — updated with all release items

---

## Vercel Deployment Fixes (this session)

- `vercel.json` — migrated from `rewrites` to `routes` with `handle: filesystem` to fix SPA catch-all swallowing `/api/*`
- Removed invalid `functions` runtime key that caused Vercel CLI 65.1.0 build failure
- Confirmed `/api/health` returns `{"status":"ok","rpcOk":true}` with latest block on Arc Testnet
- Confirmed `/api/fulfill` returns correct JSON (not HTML) when called directly
- Identified `VITE_PROVIDER_API_URL` set to `""` (with literal quotes) in Vercel — causes URLs like `https://arc-budgetrail.vercel.app/""/api/quotes` → 405. **Fix: set value to `https://arc-budgetrail.vercel.app` (no quotes) in Vercel dashboard and redeploy.**

---

## Current Test Baseline

| Suite | Pass | Fail | Notes |
|-------|------|------|-------|
| bun test (all) | 524 | 1 | 1 pre-existing: requires live localhost:3001 |
| forge test | 119 | 0 | All V1 + V2 Foundry tests |
| lint (oxlint) | 0 errors | — | 0 warnings |
| typecheck (tsc) | 0 errors | — | |

---

## Key Addresses (Public — Testnet)

| Role | Address |
|------|---------|
| V1 Contract | `0xf6a13df15ad93c2e2968e1d69c53894a923bda21` |
| USDC (Arc Testnet) | `0x3600000000000000000000000000000000000000` |
| Provider C (payout) | `0x7D76349B806148594b8075A83b2f8fb12feaA743` |
| Quote Signer D | `0x70cd9e6a417b792ecEeA2E033BdfB8F8A8113a4C` |
| Test Owner A | `0xC1CFDF533a6Da9a19e40cf9a8BFc1893DcFF2F7B` |
| Test Agent B | `0xD995d0c31802A8D95C163f875fFefB40AB964eD6` |
| Public App | `https://arc-budgetrail.vercel.app` |
| GitHub | `https://github.com/web3chandra/BudgetRail` |
