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
| Foundry V1 | 3/3 pass (+ invariant) |
| Foundry V2 | 60/60 pass (unit + invariant + C=E guard) |
| Provider | 108/108 pass |
| SDK | 66/66 pass |
| Frontend | 0 errors, 0 warnings |

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
