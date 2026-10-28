# BudgetRail — Project Memory

> Built with [Arc Studio](https://studio.arc.io) — programmable USDC payment-session vault for software agents on Arc.

This is the **project memory** for agents and developers continuing this project.

---

## What This App Does

BudgetRail is a full-stack programmable USDC payment-session vault for software agents on Arc. An Owner (A) creates a session bounded by one authorized Agent (B), a fixed Provider payout wallet (C), a separate quote Signer (D), a max total USDC budget, per-payment cap, and expiry. The Provider serves a fixed-price Document Insights API, issuing a signed EIP-712 invoice. The Agent pays through the smart contract; the Provider verifies real onchain settlement before returning a response. The Owner can close the session and reclaim unspent USDC at any time.

**V2 adds a 50 bps (0.5%) platform fee** on every payment: provider C receives the base amount, treasury E receives the fee. Fee is floor(base × 50 / 10000). V1 sessions are unchanged.

---

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS — deployed at `https://arc-budgetrail.vercel.app`
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity ^0.8.24 (compiled 0.8.28, EVM Paris, via_ir=true) + Foundry
- Provider API: Bun/TypeScript — runs on port 3001 locally, deployed as Vercel serverless functions
- Agent CLI: Bun/TypeScript — `agent/src/demoV2.ts`
- SDK: `packages/sdk/` — full V1+V2 typed client, dist/ built
- Example app: `examples/agent-app/` — uses SDK only
- Chain: Arc Testnet (Chain ID: 5042002) / Arc Mainnet (Chain ID: 5042)
- Token: USDC ERC-20 (6 decimals) — `0x3600000000000000000000000000000000000000` (same on testnet and mainnet)
- Native gas: USDC at 18 decimals (same pool, different decimal view — not a second token)

---

## Deployed Contracts

| Contract | Network | Address | Deploy Tx | Block |
|----------|---------|---------|-----------|-------|
| BudgetRail (V1) | Arc Testnet | `0xf6a13df15ad93c2e2968e1d69c53894a923bda21` | `0xf33cb9096a45c5cc083fbee4366384f4257f509ab94fe46ec4291e775bc4a5d9` | 67,538,363 |
| BudgetRailV2 | Arc Testnet | NOT YET DEPLOYED | — | — |
| BudgetRail (V1) | Arc Mainnet | NOT YET DEPLOYED | — | — |
| BudgetRailV2 | Arc Mainnet | NOT YET DEPLOYED | — | — |

V1 Explorer: https://explorer.testnet.arc.io/address/0xf6a13df15ad93c2e2968e1d69c53894a923bda21

**After V2 testnet deploy:** update `VITE_BUDGET_RAIL_V2_ADDRESS` in `.env`, `v2DeployBlock` in `src/lib/arcProfile.ts`, and add the address here.

---

## Role Addresses (public)

| Role | Address | Purpose |
|------|---------|---------|
| Provider payout C | `0x7D76349B806148594b8075A83b2f8fb12feaA743` | Receives base payment per call |
| Quote signer D (public) | `0x70cd9e6a417b792ecEeA2E033BdfB8F8A8113a4C` | Signs EIP-712 quotes |
| Treasury E (V2) | `0x7D76349B806148594b8075A83b2f8fb12feaA743` | Receives 50 bps fee (currently same as C — must separate before mainnet) |

---

## Public URLs

| Resource | URL |
|----------|-----|
| Frontend | https://arc-budgetrail.vercel.app |
| Provider health | https://arc-budgetrail.vercel.app/api/health |
| Arc Testnet explorer | https://explorer.testnet.arc.io |
| V1 contract | https://explorer.testnet.arc.io/address/0xf6a13df15ad93c2e2968e1d69c53894a923bda21 |

---

## Key Files

| File | Purpose |
|------|---------|
| `contracts/BudgetRail.sol` | V1 contract (deployed) |
| `contracts/BudgetRailV2.sol` | V2 contract (tested, not deployed) |
| `contracts/test/BudgetRail.t.sol` | V1 Foundry tests |
| `contracts/test/BudgetRailV2.t.sol` | V2 Foundry tests (60/60 pass) |
| `src/lib/arcProfile.ts` | Centralized chain/contract config (update after V2 deploy) |
| `src/lib/budgetRail.ts` | V1 ABI + read helpers |
| `src/lib/budgetRailV2.ts` | V2 ABI + fee math (`computeFeeV2`) |
| `src/lib/historyScanner.ts` | Windowed event scanner with coverage metadata |
| `provider/src/lib/config.ts` | Provider config (env vars, V1+V2) |
| `provider/src/lib/eip712.ts` | EIP-712 V1+V2 quote signing |
| `provider/src/routes/quotes.ts` | POST /api/quotes (V1) |
| `provider/src/routes/fulfill.ts` | POST /api/fulfill (V1) |
| `provider/src/routes/quotesV2.ts` | POST /api/quotes/v2 |
| `provider/src/routes/fulfillV2.ts` | POST /api/fulfill/v2 |
| `packages/sdk/src/` | Full V1+V2 SDK |
| `packages/sdk/dist/` | Built distributable |
| `agent/src/demoV2.ts` | V2 agent CLI |
| `examples/agent-app/` | External app using SDK only |
| `scripts/v2-testnet-demo.ts` | 8-step testnet demo CLI (dry-run) |
| `scripts/check-v2-deploy.ts` | V2 preflight checker |
| `api/` | Vercel serverless function wrappers |
| `evidence/testnet.json` | Real testnet evidence (V1 lifecycle: TODO) |
| `evidence/mainnet.json` | Mainnet evidence schema (all TODO) |
| `docs/SECURITY-AUDIT-PART10.md` | Full security audit report |
| `docs/MAINNET-DEPLOY-RUNBOOK.md` | Step-by-step mainnet deploy guide |
| `docs/GO-NOGO-MATRIX.md` | Release decision matrix |
| `docs/V2-TESTNET-PLAN.md` | V2 testnet demo plan |
| `PENDING.md` | Open tasks tracker |

---

## Test Status

| Suite | Result |
|-------|--------|
| Foundry (V1 + V2 unit + invariants) | 119/119 pass |
| Provider (V1) | all pass |
| Provider (V2) | 39/39 pass — Part 04 requestHash fixture update applied |
| Provider fee-math | 15/15 pass — Part 05 |
| Provider HTTP smoke | 22/22 pass — Part 06 |
| SDK | all pass |
| Part 07+08 regression | 54/54 pass — network isolation, role logic, bigint arithmetic |
| Frontend lint + typecheck | 0 errors, 0 warnings |
| bun test (all) | 524/525 pass — 1 pre-existing localhost:3001 integration fail |

**Parts 09+10 (COMPLETE):**
- `provider/src/lib/onchain.ts` — `readSession` + `readSessionV2` now propagate RPC errors instead of swallowing them; callers correctly return 503 on RPC failure instead of 404 "not found"
- `.github/workflows/ci.yml` — added `secret-scan` job (gitleaks full-history) and `abi-consistency` job (forge inspect selectors); corrected test count comments
- `docs/SECURITY-AUDIT-PART09.md` — full audit report: secrets inventory, Solidity review, API audit, economic logic, CI, docs accuracy, mainnet GO/NO-GO
- `docs/QA-REGRESSION-REPORT.md` — per-subsystem PASS/FAIL/BLOCKED with live onchain evidence (sessions #20/#21 read directly from Arc Testnet), manual real-testnet tx checklist

**Part 11 (COMPLETE — mainnet preflight, runbook, release):**
- `docs/GO-NOGO-MATRIX.md` — fully rewritten with current test counts (119/119 Foundry, 524/525 bun), Parts 09/10 fixes reflected, critical path to grant submission updated for Oct 27 date
- `docs/MAINNET-DEPLOY-RUNBOOK.md` — fixed critical bug: Gate 6.4 `payForRequestV2` was missing `requestHash` parameter (added in Part 04); updated stale test counts; added explicit IMPORTANT warning about requestHash
- `evidence/mainnet.json` — added `sourceHash_sha256` for both contracts (verified via sha256sum Part 11), ABI selector table for V1 and V2 (from forge inspect), duplicate v1Contract stub removed
- `docs/VIDEO-STORYBOARD.md` — new: 8-scene 2:30 demo storyboard covering Owner→Agent→Provider→Treasury→Refund flow, honest version/chain labelling, micro-fee disclosure
- `docs/PUBLIC-RELEASE-CHECKLIST.md` — updated stale test counts (60→119 Foundry, 108→150 provider)
- Contract source hashes (Part 11): BudgetRail.sol=be9ff649..., BudgetRailV2.sol=94f4e3cf...
- ABI selectors verified: V1 payForRequest=62f7482a, V2 payForRequestV2=0814315c (distinct — correct)
- Arc grant requirements: web search rate-limited; known facts confirmed from existing docs; operator must independently verify current official criteria at arc.io before submission
- **Final test counts: 524/525 bun, 119/119 Foundry, 0 lint errors, 0 typecheck errors**

---

## Parts Completed

| Part | Title | Status |
|------|-------|--------|
| 01 | Audit baseline | Done |
| 02 | History data model | Done |
| 03 | Wallet role clarity | Done |
| 04 | UX fixes | Done |
| 05 | V2 fee spec | Done |
| 06 | V2 contract | Done |
| 07 | V2 provider + agent | Done |
| 08 | V2 frontend | Done |
| 09 | SDK + example app | Done |
| 10 | Security audit | Done |
| 11 | Testnet preflight | Done |
| 12 | Mainnet + grant prep | Done |

**Part 04 (current session — P0 security fix — COMPLETE):**
- `BudgetRailV2.sol` — `_PAYMENT_QUOTE_V2_TYPEHASH` and `payForRequestV2` now include `bytes32 requestHash`; `PaymentSettledV2` emits it as a non-indexed field
- `provider/src/lib/eip712.ts` — `PaymentQuoteV2` interface + `PAYMENT_QUOTE_V2_TYPES` include `requestHash`; `signQuoteV2` passes it
- `provider/src/routes/quotesV2.ts` — passes `requestHash` to `signQuoteV2`
- `provider/src/routes/fulfillV2.ts` — verifies `settled.requestHash` (onchain event) against SHA-256(input)
- `provider/src/lib/onchain.ts` — `BUDGET_RAIL_V2_ABI` event + decoder updated for new field order
- `packages/sdk/src/abi.ts`, `types.ts`, `pay.ts`, `read.ts` — all updated; `quoteDeadline` → `deadline`
- `packages/sdk/src/quote.ts` — `normalizeQuoteV2` and `verifyQuoteV2` updated; domain name corrected to "BudgetRail"; typehash field order matches contract
- `contracts/test/BudgetRailV2.t.sol` — `QUOTE_V2_TYPEHASH`, `_sign()`, `_signBase()`, `_pay()`, all call sites, EVT-01 decode, handler typehash all updated
- `provider/test/fulfillV2.test.ts` — `makePaymentSettledV2Log` and `makeQuoteV2` fixtures updated with `requestHash`; `REQUEST_HASH` constant added
- `vercel.json` — P0-V2-REWRITE fixed: `/api/quotes/v2` → `/api/quotes/v2`; `/api/fulfill/v2` → `/api/fulfill/v2` (not the non-existent `/api/quotesV2`/`/api/fulfillV2`)

**Parts 05+06 (COMPLETE):**
- `provider/src/lib/config.ts` — Private key format validation at startup; C==E mainnet hard-fail guard
- `api/rpc.ts` — `BLOCKED_METHODS` (eth_sendRawTransaction, eth_sendTransaction); `fetchWithRetry` with 600ms backoff on 429/503
- `src/pages/Playground.tsx` — Confirm modal: V2 shows base/fee/gross breakdown instead of single "USDC charge"
- `provider/test/feeArithmetic.test.ts` — 15 new fee-arithmetic unit tests (boundaries 199/200/201, large values, invariants)
- `provider/test/httpSmoke.test.ts` — 22 new HTTP smoke tests (health, V1/V2 routes, segregation, config validation)

**Parts 07+08 (COMPLETE):**
- `src/components/NetworkGuard.tsx` — Uses `ARC.chainId` + `ARC.chainName` (was hardcoded arcTestnet.id / "Arc Testnet")
- `src/hooks/useSessionFlow.ts` — `CHAIN_ID = ARC.chainId` (removed arcTestnet import)
- `src/pages/CreateBudget.tsx` — `CHAIN_ID = ARC.chainId`; chain label dynamic (removed arcTestnet import)
- `src/pages/ManageSession.tsx` — `CHAIN_ID = ARC.chainId` (removed arcTestnet import)
- `src/pages/Dashboard.tsx` — `CHAIN_ID = ARC.chainId`; subtitle uses `ARC.chainName` (removed arcTestnet import)
- `src/pages/Playground.tsx` — `CHAIN_ID = ARC.chainId`; wrong-network message dynamic (removed arcTestnet import)
- `src/config.ts` — Imports Arc Mainnet as `arc as arcMainnet` (was `arcMainnet` — non-existent export); includes Arc Mainnet transport
- `src/test/part07part08Regression.test.ts` — 54 new tests: role logic, bigint arithmetic, network isolation, arcProfile guards

---

## Environment Variables Required

### Root `.env` (frontend + Vite)
```
VITE_BUDGET_RAIL_ADDRESS=0xf6a13df15ad93c2e2968e1d69c53894a923bda21
VITE_BUDGET_RAIL_V2_ADDRESS=      # set after V2 deploy
VITE_PROVIDER_PAYOUT=0x7D76349B806148594b8075A83b2f8fb12feaA743
VITE_QUOTE_SIGNER=0x70cd9e6a417b792ecEeA2E033BdfB8F8A8113a4C
VITE_TREASURY_ADDRESS=0x7D76349B806148594b8075A83b2f8fb12feaA743
VITE_PROVIDER_API_URL=            # empty = use /api proxy (sandbox) or Vercel functions
VITE_ARC_NETWORK=testnet
VITE_ARC_TESTNET_RPC=             # set if using custom RPC
```

### `provider/.env`
```
PROVIDER_NETWORK=testnet
PROVIDER_PAYOUT_ADDRESS=0x7D76349B806148594b8075A83b2f8fb12feaA743
QUOTE_SIGNER_PRIVATE_KEY=         # KEEP SECRET — rotate before mainnet
ALLOWED_ORIGIN=https://arc-budgetrail.vercel.app
BUDGET_RAIL_V2_ADDRESS=           # set after V2 deploy
TREASURY_ADDRESS=0x7D76349B806148594b8075A83b2f8fb12feaA743
```

### Vercel Environment Variables (dashboard → Settings → Environment Variables)
```
QUOTE_SIGNER_PRIVATE_KEY          # your D signing key (SECRET)
PROVIDER_PAYOUT_ADDRESS           # 0x7D76349B806148594b8075A83b2f8fb12feaA743
PROVIDER_NETWORK                  # testnet
ALLOWED_ORIGIN                    # https://arc-budgetrail.vercel.app
```

---

## To Run Locally

```bash
bun install
bun run dev          # starts Vite (port 5173) + provider (port 3001) concurrently
```

## To Build and Test

```bash
bun run contracts:build   # forge build
bun run contracts:test    # forge test
bun run test:provider     # cd provider && bun test
bun run test:sdk          # cd packages/sdk && bun test
bash /home/user/arc-studio-helpers/check.sh  # lint + typecheck
```

## To Deploy V2 (testnet, dry-run only)

```bash
bun run v2:preflight --network testnet
bun run v2:testnet-demo --step preflight
# then step-by-step — see docs/V2-TESTNET-PLAN.md
```
