# BudgetRail — Arc Studio Provenance

This file records the full provenance chain from the Arc Studio project to every deployed contract,
test run, and submitted artifact. All values are real; nothing is fabricated.

---

## Studio Project

- **Studio Project URL**: https://studio.arc.io (session preserved in Arc Studio workspace)
- **Project name**: BudgetRail
- **Build context**: Arc Microgrant submission — Parts 1–11 built in a single Arc Studio project
- **All source files** (contract, tests, provider API, agent CLI, frontend) were created and validated within this Arc Studio project

---

## Contract Deployment — Arc Testnet

| Field | Value |
|-------|-------|
| Contract name | BudgetRail |
| Chain | Arc Testnet |
| Chain ID | 5042002 |
| Contract address | `0xf6a13df15ad93c2e2968e1d69c53894a923bda21` |
| Deploy tx hash | `0xf33cb9096a45c5cc083fbee4366384f4257f509ab94fe46ec4291e775bc4a5d9` |
| Explorer (address) | https://explorer.testnet.arc.io/address/0xf6a13df15ad93c2e2968e1d69c53894a923bda21 |
| Explorer (tx) | https://explorer.testnet.arc.io/tx/0xf33cb9096a45c5cc083fbee4366384f4257f509ab94fe46ec4291e775bc4a5d9 |
| Deployed at | 2026-10-16T18:01:47.925Z |
| Deployer | Circle-managed testnet deployer (Arc Studio `deploy_contract` tool) |
| Constructor arg | `0x3600000000000000000000000000000000000000` (canonical Arc USDC ERC-20) |

---

## USDC Verification (Arc Testnet)

| Field | Value |
|-------|-------|
| USDC ERC-20 address | `0x3600000000000000000000000000000000000000` |
| `decimals()` onchain | **6** |
| Verification method | `read_contract` tool, Arc_Testnet, address=0x3600..., `decimals() returns (uint8)` → 6 |
| Deployed `USDC_ADDRESS()` | `0x3600000000000000000000000000000000000000` (confirmed onchain via `read_contract`) |
| Native gas USDC decimals | 18 (gas meter view — same pool, NOT a second token) |

---

## Test Results — Actually Executed

### Smart contract tests (Foundry)

Command: `forge test`

| Suite | Tests | Pass | Fail |
|-------|-------|------|------|
| BudgetRailTest | 57 | 57 | 0 |
| BudgetRailInvariant | 2 | 2 | 0 |
| **Total** | **59** | **59** | **0** |

Invariants: 256 sequences × 500 calls = 128,000 calls each, 0 reverts.
Compiler: solc 0.8.28, EVM Paris, optimizer 200 runs.

### Provider API tests (Bun)

Command: `cd provider && bun test`

| File | Tests | Pass |
|------|-------|------|
| test/eip712.test.ts | 11 | 11 |
| test/insights.test.ts | 13 | 13 |
| test/quotes.test.ts | 19 | 19 |
| test/fulfill.test.ts | 21 | 21 |
| **Total** | **64** | **64** |

### Agent CLI tests (Bun)

Command: `cd agent && bun test src/test/`

| File | Tests | Pass |
|------|-------|------|
| src/test/agent.test.ts | 15 | 15 |
| **Total** | **15** | **15** |

### Frontend checks

Command: `bun run check` (oxlint + tsc --noEmit)

| Check | Errors |
|-------|--------|
| Lint (oxlint) | 0 |
| TypeScript | 0 |

---

## Source Files

| File | Purpose | Part |
|------|---------|------|
| `contracts/BudgetRail.sol` | Smart contract (295 lines) | 2 |
| `contracts/test/BudgetRail.t.sol` | Foundry tests (59 tests) | 3 |
| `contracts/out/BudgetRail.sol/BudgetRail.json` | Compiled artifact + ABI | 3 |
| `provider/src/lib/config.ts` | Provider config (env vars) | 5 |
| `provider/src/lib/eip712.ts` | EIP-712 quote signing | 5 |
| `provider/src/lib/insights.ts` | Document Insights v1 | 5 |
| `provider/src/lib/onchain.ts` | Read-only viem client + log decoders | 5–6 |
| `provider/src/lib/ratelimit.ts` | Per-session rate limiter | 5 |
| `provider/src/routes/health.ts` | GET /api/health | 5 |
| `provider/src/routes/quotes.ts` | POST /api/quotes | 5 |
| `provider/src/routes/fulfill.ts` | POST /api/fulfill (14 checks) | 6 |
| `provider/test/` | 64 provider unit tests | 6 |
| `agent/src/lib/` | Chain reads/writes, EIP-712 verify, config | 9 |
| `agent/src/demo.ts` | Full agent demo CLI | 9 |
| `agent/src/test/agent.test.ts` | 15 agent unit tests | 9 |
| `src/pages/Dashboard.tsx` | Owner dashboard | 7 |
| `src/pages/CreateBudget.tsx` | Session creation stepper | 7 |
| `src/pages/Playground.tsx` | Quote + pay + fulfill UI | 7 |
| `src/pages/PaymentHistory.tsx` | On-chain payment log | 7 |
| `src/pages/ManageSession.tsx` | Close session + refund | 7 |
| `docs/BudgetRail-contract.md` | Contract technical reference | 2 |
| `docs/ARCHITECTURE.md` | System architecture | 10 |
| `docs/SECURITY.md` | Security review | 10 |
| `docs/API.md` | Provider API reference | 10 |
| `docs/TEST-REPORT.md` | Test report (actual results) | 10 |
| `docs/DEPLOYMENT.md` | Deployment runbook | 10–11 |
| `docs/DEMO-SCRIPT.md` | 2–3 min video walkthrough | 11 |
| `evidence/testnet.json` | Testnet deploy evidence | 4 |
| `evidence/mainnet.json` | Mainnet evidence placeholder | 11 |
| `.github/workflows/ci.yml` | CI pipeline | 10 |

---

## Mainnet Deployment

> **Not yet deployed. Requires operator's independent review and explicit authorization.**
> See `docs/DEPLOYMENT.md` for the exact runbook.

When deployed, populate `evidence/mainnet.json` with real values only.

---

## Submission links

- **Studio Project URL**: (insert after export — use the Arc Studio share link)
- **Live app URL**: (insert after deploy)
- **GitHub repo**: (insert after push)
- **Mainnet contract**: (insert from `evidence/mainnet.json` after deploy)
- **Builder profile**: (insert GitHub/X/Farcaster handle)
