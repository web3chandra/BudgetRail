# Part 07 + Part 08 — Implementation Report

**Date:** 2026-10-26
**Status:** COMPLETE — ready for operator review before next part.

---

## Test Counts (final run)

| Suite | Pass | Fail | Notes |
|-------|------|------|-------|
| `bun test` (all workspaces) | 524 | 1 | 1 pre-existing fail: localhost:3001 HTTP integration |
| `forge test` | 119 | 0 | Includes V1 unit, V2 unit, V1 invariant, V2 invariant |
| Lint (`oxlint`) | 0 errors | — | 0 warnings |
| TypeCheck (`tsc --noEmit`) | 0 errors | — | — |
| **New tests added** | **54** | — | `part07part08Regression.test.ts` (54 tests) |

Pre-existing fail (unchanged from Part 06): `Provider HTTP integration > POST /api/quotes: provider correctly rejects sessions whose onchain quoteSigner does not match the server key` — requires a live provider server at localhost:3001 and is not a code defect.

---

## Part 07 — Wallet Role UX, Session Create/Fund/Top-up and Permissions

### Audit findings — all pages

All existing pages (`CreateBudget`, `ManageSession`, `Playground`, `WalletRolePanel`, `useSessionFlow`) already implement the required semantics correctly as of the end of Part 06:

- Owner A = `msg.sender` that signs the create transaction — never inferred, cached, or taken from ENS.
- Agent B is separately entered as a form field, never auto-filled.
- Provider C is labeled "configured by service operator — not your wallet."
- `createSession` creates a zero-funded session; `fundSession` is the separate funding step. The UI flow does not promise exactly N wallet prompts.
- Recovery banner: shown when a confirmed-but-unfulfilled tx hash is in localStorage; the retry path calls `retrieveResult` without re-paying.
- Wrong-wallet guard: Playground blocks the agent payment button when the connected wallet is not session.agent.
- Ownership proof panel: shown only when connected address === `session.provider` (Provider C).
- `A=B` warning: shown in Playground's demo-mode banner.
- Session share link: `/sessions/:id` works cross-browser via React Router with no localStorage dependency.

**Root cause of the network isolation bug (P07-A, fixed this part):**

`NetworkGuard.tsx` had `TARGET_CHAIN_ID = arcTestnet.id` hardcoded. On a mainnet build (`VITE_ARC_NETWORK=mainnet`), `ARC.chainId` is `5042` but the guard still prompted for `5042002`. Same issue in all five page files and `useSessionFlow.ts` — all used `arcTestnet.id` directly.

### Fixes applied

| File | Change |
|------|--------|
| `src/components/NetworkGuard.tsx` | `TARGET_CHAIN_ID = ARC.chainId`; `TARGET_CHAIN_NAME = ARC.chainName` (was hardcoded "Arc Testnet") |
| `src/hooks/useSessionFlow.ts` | `CHAIN_ID = ARC.chainId`; removed `arcTestnet` import |
| `src/pages/CreateBudget.tsx` | `CHAIN_ID = ARC.chainId`; "Arc Testnet chain {CHAIN_ID}" → `{ARC.chainName} (chain {ARC.chainId})`; removed `arcTestnet` import |
| `src/pages/ManageSession.tsx` | `CHAIN_ID = ARC.chainId`; removed `arcTestnet` import |
| `src/pages/Dashboard.tsx` | `CHAIN_ID = ARC.chainId`; "Arc Testnet" subtitle → `{ARC.chainName}`; removed `arcTestnet` import |
| `src/pages/Playground.tsx` | `CHAIN_ID = ARC.chainId`; "Switch to Arc Testnet (chain 5042002)" → dynamic; removed `arcTestnet` import |

**Before:** On a mainnet build, `NetworkGuard` would prompt users to switch to Arc Testnet (chain 5042002) even though the correct chain is Arc Mainnet (5042). All create/fund/pay transactions would target the wrong chain ID.

**After:** All chain references read from `ARC.chainId` at module load time. Setting `VITE_ARC_NETWORK=mainnet` switches every guard, transport, and user-facing label automatically.

### Test coverage (Part 07)

Tests in `src/test/part07part08Regression.test.ts`:

- `parseUsdcUnits` — 12 tests: whole amounts, sub-cent precision, million USDC, zero, empty, negative, non-numeric, lone decimal, 7th-decimal truncation, bigint type guarantee, float-contamination regression.
- `isValidAddress` — 6 tests: valid checksummed, valid uppercase, empty, no-prefix, too-short, ENS name, non-hex.
- Role permission semantics — 7 tests: owner, agent, A=B, A=C, provider C, viewer, disconnected.
- Top-up headroom math — 5 tests: zero headroom, partial headroom, available-now, full-spend, validation logic.

---

## Part 08 — Network Isolation, SDK and Cross-Project Integration

### Audit findings

**P08-A (fixed):** `src/config.ts` imported `arcMainnet` from `viem/chains` but the correct export name is `arc` (aliased `arc as arcMainnet`). This caused a TypeScript error and prevented the wagmi config from including the mainnet transport. Fixed by using `import { arcTestnet, arc as arcMainnet } from 'viem/chains'`.

**Existing correct:** `arcProfile.ts` already has dual-profile, fail-closed mainnet guard, `V2_CONFIGURED` check, `assertCorrectNetwork()`, and `providerConfigError()`. No changes needed there.

**SDK (packages/sdk/):** All SDK functions are chain-agnostic (take `config.rpcUrl`, `config.chainId`). No hardcoded chain IDs. No changes needed.

**Standalone example (`examples/agent-app/`):** Already a full runnable Bun dry-run demo with:
- `src/config.ts` — reads all addresses from env (no hardcoding except the known V1 address), builds `BudgetRailConfig` and `BudgetRailV2Config`.
- `src/main.ts` — offline fee simulation (no wallet/RPC), live session read, V2 quote + verify, treasury check, history scan, payment simulation.
- `bun run simulate` — offline-only mode, no private key needed.
- Distinguishes `BudgetRailError` codes: `PROVIDER_UNREACHABLE`, `PROVIDER_MISMATCH`, `SIGNER_MISMATCH`, `WRONG_CHAIN`, `RPC_ERROR`.
- No embedded private keys; agent key only loaded when `AGENT_PRIVATE_KEY` is set.

No changes needed to the example.

### Fixes applied

| File | Change |
|------|--------|
| `src/config.ts` | `import { arcTestnet, arc as arcMainnet } from 'viem/chains'` (was `arcMainnet` — wrong name, does not exist) |

### Test coverage (Part 08)

Tests in `src/test/part07part08Regression.test.ts` (network isolation section):

- ARC profile shape — 7 tests: network string, chainId matches network, chainName non-empty, rpcUrl non-empty, explorerBase HTTPS, USDC canonical, deployBlock type.
- `PROVIDER_CONFIGURED` / `V2_CONFIGURED` guards — 3 tests.
- `assertCorrectNetwork` — 4 tests: correct chain passes, wrong chain throws, error includes both chains, Ethereum mainnet rejected.
- Network isolation invariants — 6 tests: chainId is testnet or mainnet, not Ethereum 1, mainnet rejects zero contract, USDC same on both chains, V2 not falling back to V1 address, providerApiUrl suffix check.

---

## Remaining Open Items (unchanged from Part 06)

| ID | Action | Owner |
|----|--------|-------|
| P0-A | Rotate `QUOTE_SIGNER_PRIVATE_KEY` | Operator |
| P0-C | Execute V1 testnet lifecycle, fill `evidence/testnet.json` | Operator |
| H-01 | Deploy V2 contract to testnet, set `VITE_BUDGET_RAIL_V2_ADDRESS` + `BUDGET_RAIL_V2_ADDRESS` | Operator |
| H-02 | Decide final C/E wallet separation for V2 | Operator |
| M-02 | Add all Vercel env vars to Vercel dashboard, redeploy | Operator |
| M-04 | Separate C and E wallet addresses before mainnet | Operator |
| L-02 | GitHub PAT workflow scope (CI) | Operator |
| L-05 | npm publish approval for `@budgetrail/sdk` | Operator |
