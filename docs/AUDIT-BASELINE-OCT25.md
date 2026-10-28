# BudgetRail — Audit Baseline, October 25 2026
## PART 00: Read-Only Baseline, Architecture & Deployment ABI Audit

**Status: AUDIT-ONLY — no code was modified during this part.**
**Author: Arc Studio automated audit pass**
**Project root: /home/user/app (BudgetRail monorepo)**

---

## 1. Repository Inventory

### Top-level structure

```
/home/user/app/
├── contracts/
│   ├── BudgetRail.sol           V1 — deployed testnet (295 lines)
│   ├── BudgetRailV2.sol         V2 — NOT deployed (476 lines)
│   ├── test/BudgetRail.t.sol    Foundry tests
│   ├── test/BudgetRailV2.t.sol  Foundry tests
│   ├── test-helpers/MockERC20.sol
│   ├── script/DeployCreate2.s.sol
│   └── contract-metadata/BudgetRail.json  Deployment metadata + ABI
├── src/                         Vite + React frontend
│   ├── lib/budgetRail.ts        Frontend ABI + address constants
│   ├── lib/historyScanner.ts    Event log scanner with checkpoint cache
│   ├── lib/arcProfile.ts        Chain/USDC config profile
│   ├── pages/                   Dashboard, CreateBudget, ManageSession, Playground, etc.
│   └── components/              WalletRolePanel, Layout, etc.
├── provider/                    Standalone Bun API server (port 3001)
│   └── src/
│       ├── lib/config.ts        Env-based config loader
│       ├── lib/eip712.ts        EIP-712 signing
│       ├── lib/onchain.ts       Chain reads
│       └── routes/              quotes.ts, fulfill.ts, health.ts, explorerUrls.ts
├── api/                         Vercel serverless wrappers
│   ├── rpc.ts                   RPC proxy
│   ├── health.ts
│   ├── quotes.ts
│   ├── fulfill.ts
│   ├── quotes/v2.ts
│   └── fulfill/v2.ts
├── packages/sdk/                TypeScript SDK (V1 + V2)
├── agent/                       Demo agent CLI
├── evidence/
│   ├── testnet.json             PENDING — lifecycle not executed
│   └── mainnet.json             PLACEHOLDER — mainnet not deployed
├── vercel.json                  Root Vercel deploy config
├── public/vercel.json           SPA catch-all (auto-copied to dist/ by Vite)
└── docs/                        Architecture, security, runbook docs
```

### Test counts (from prior runs — not re-executed in this read-only pass)
| Suite | Count | Last known result |
|---|---|---|
| Foundry BudgetRail.t.sol | 60 | PASS |
| Foundry BudgetRailV2.t.sol | 60 | PASS (within the 60 above) |
| Provider bun test | 108 | PASS |
| SDK bun test | 66 | PASS |
| Frontend regression (src/test/) | 27 | PASS |

---

## 2. Onchain Verification — V1 Contract

### Live RPC reads (Arc Testnet, chain 5042002)

**Contract:** `0xf6a13df15ad93c2e2968e1d69c53894a923bda21`

| Check | Expected | Actual (live read) | Match |
|---|---|---|---|
| `USDC_ADDRESS()` | `0x3600000000000000000000000000000000000000` | `0x3600000000000000000000000000000000000000` | YES |
| `getSession(22).owner` | `0xD995d0c31802A8D95C163f875fFefB40AB964eD6` | `0xD995d0c31802A8D95C163f875fFefB40AB964eD6` | YES |
| `getSession(22).agent` | `0xC1CFDF533a6Da9a19e40cf9a8BFc1893DcFF2F7B` | `0xC1CFDF533a6Da9a19e40cf9a8BFc1893DcFF2F7B` | YES |
| `getSession(22).provider` | `0x7D76349B806148594b8075A83b2f8fb12feaA743` | `0x7D76349B806148594b8075A83b2f8fb12feaA743` | YES |
| `getSession(22).quoteSigner` | `0x70cd9e6a417b792ecEeA2E033BdfB8F8A8113a4C` | `0x70cd9e6a417b792ecEeA2E033BdfB8F8A8113a4C` | YES |
| `getSession(22).maxBudget` | `1000000` (=$1.00 USDC) | `1000000` | YES |
| `getSession(22).totalFunded` | `500000` (=$0.50) | `500000` | YES |
| `getSession(22).totalSpent` | `50000` (=$0.05) | `50000` | YES |
| `getSession(22).closed` | `false` | `false` | YES |

**RPC health: HEALTHY.** All reads succeeded.

### ABI selector verification

The `contracts/contract-metadata/BudgetRail.json` ABI was cross-checked against `contracts/BudgetRail.sol` source:

| Function | Source | ABI | Match |
|---|---|---|---|
| `createSession(address,address,address,uint96,uint96,uint64)` | YES | YES | YES |
| `fundSession(uint256,uint96)` | YES | YES | YES |
| `payForRequest(uint256,bytes32,bytes32,uint96,uint64,bytes)` | YES | YES | YES |
| `closeSession(uint256)` | YES | YES | YES |
| `getSession(uint256)` | YES | YES | YES |
| `availableBalance(uint256)` | YES | YES | YES |
| `sessionIdsByOwner(address,uint256,uint256)` | YES | YES | YES |
| `ownerSessionCount(address)` | YES | YES | YES |

**IMPORTANT CORRECTION to earlier docs:** `createSession` does NOT pull USDC. It only creates the record and emits `SessionCreated`. The separate `fundSession` call pulls USDC. The UI calls them in sequence: createSession → fundSession. Earlier documentation claiming they are combined is WRONG. Source and ABI both confirm they are separate.

**IMPORTANT CORRECTION:** The V1 payer function is `payForRequest`, NOT `pay()`. Any reference to `pay()` in earlier docs or the agent code is wrong.

### V1 EIP-712 typehash

From source line 70-73:
```
PaymentQuote(uint256 sessionId,bytes32 requestId,bytes32 requestHash,uint256 amount,uint64 quoteDeadline)
```
This includes `requestHash` — the hash of the actual input content. This BINDS the quote to a specific document. The quote cannot be replayed against different content.

---

## 3. Canonical Role Map A/B/C/D/E

| Letter | Role | Set at | Mutable | Restrictions |
|---|---|---|---|---|
| **A** | Owner | `createSession` (`msg.sender`) | NEVER | Can: fundSession, closeSession. Cannot: pay, receive provider payment |
| **B** | Agent | `createSession(agent)` arg | NEVER | Can: payForRequest. Cannot: fund, close, receive refund |
| **C** | Provider payout | `createSession(provider)` arg | NEVER | Receives USDC on every payForRequest. No contract-callable functions |
| **D** | Quote signer | `createSession(quoteSigner)` arg | NEVER | Signs EIP-712 quotes off-chain. Private key on provider server only |
| **E** | Treasury (V2 only) | `BudgetRailV2` constructor | NEVER (immutable) | Receives fee (0.5% of baseAmount) on every V2 payForRequestV2. Not in V1 |

**Key facts:**
- A, B, C can share an address — permissions are additive. Example: if A==B, the owner can also pay.
- Deployer address has NO special role. It does not automatically receive USDC or have admin rights.
- C and E can share an address (testnet case: both are `0x7D76...743`). This is valid for testnet. Before mainnet, they should be separated so platform fee is distinguishable from provider revenue.
- There is no admin, no owner of the contract itself, no pause function, no sweep function.

**Session 22 resolved roles (live from chain):**
```
A (Owner):          0xD995d0c31802A8D95C163f875fFefB40AB964eD6  (sh555.eth, Brave)
B (Agent):          0xC1CFDF533a6Da9a19e40cf9a8BFc1893DcFF2F7B  (Edge incognito)
C (Provider payout): 0x7D76349B806148594b8075A83b2f8fb12feaA743  (service config)
D (Quote signer):   0x70cd9e6a417b792ecEeA2E033BdfB8F8A8113a4C  (server private key)
E (Treasury, V2):   0x7D76349B806148594b8075A83b2f8fb12feaA743  (same as C — testnet only)
```

---

## 4. Deployment Status

### V1 — Arc Testnet
| Field | Value | Source | Verified |
|---|---|---|---|
| Address | `0xf6a13df15ad93c2e2968e1d69c53894a923bda21` | contract-metadata/BudgetRail.json | YES (live read) |
| Chain | Arc Testnet (5042002) | metadata | YES (live read) |
| Deploy tx | `0xf33cb9096a45c5cc083fbee4366384f4257f509ab94fe46ec4291e775bc4a5d9` | metadata | NOT re-verified this pass |
| Deployed at | 2026-10-16T18:01:47.925Z | metadata | NOT re-verified this pass |
| Deploy block | 67_538_363 | AGENTS.md | NOT re-verified this pass |
| USDC_ADDRESS onchain | `0x3600000000000000000000000000000000000000` | live read | YES |

### V1 — Mainnet
**Status: NOT DEPLOYED.** `evidence/mainnet.json` is a placeholder with all null values. No mainnet deployment has occurred. Do not assert otherwise.

### V2 — Testnet
**Status: NOT DEPLOYED.** `evidence/testnet.json` v2Contract section is all null. V2 source code is complete and tested but no deployment transaction has been executed.

### V2 — Mainnet
**Status: NOT DEPLOYED.** Same as above.

### Testnet lifecycle evidence
`evidence/testnet.json` `testnetLifecycle` section: all null. The 6-step lifecycle (createSession → fundSession → payForRequest × 2 → replay attempt → closeSession) has NOT been manually executed and documented. Session #22 exists onchain but is not recorded in evidence/testnet.json.

---

## 5. Secret Exposure Risk Assessment

**Rule: only variable names and locations are reported here, never values.**

| Secret | Location | Gitignored | Risk |
|---|---|---|---|
| `QUOTE_SIGNER_PRIVATE_KEY` | `provider/.env` | YES (.env.* rule) | LOW locally. CRITICAL on Vercel — must be in dashboard, never in repo |
| `AGENT_PRIVATE_KEY` | `agent/agent.env` | YES (agent.env rule) | LOW locally |
| `CIRCLE_API_KEY` | `.env` (if present) | YES (.env.* rule) | LOW locally |
| `CIRCLE_ENTITY_SECRET` | `.env` (if present) | YES (.env.* rule) | LOW locally |

**Confirmed safe:**
- `env.example.txt` and `provider/env.example.txt` are in `.gitignore` — will not be committed.
- `console.jsonl` and `traces.jsonl` are in `.gitignore`.
- No private key value appears in any `.ts` source file (confirmed by reading config.ts — only `process.env[name]` access).
- No secret is returned in any API response body (confirmed in quotes.ts — only the signature and public signer address are returned).

**Risk: api/ functions leak error message containing `loadConfig()` exception text to browser (HTTP 500 body).** If `QUOTE_SIGNER_PRIVATE_KEY` env var is missing, the error message "Missing required env variable: QUOTE_SIGNER_PRIVATE_KEY" is returned to the browser in the 500 response body. This reveals the variable name (not the value), which is low severity but should be sanitised to a generic "server configuration error" for production.

---

## 6. Defect Registry

### P0 — Critical (must fix before mainnet)

#### P0-V2-REWRITE: `vercel.json` routes V2 API to non-existent destinations
**File:** `vercel.json` lines 12-13
**Severity:** P0 for V2 functionality. V1 is unaffected.
**Finding:**
```json
{ "source": "/api/quotes/v2",  "destination": "/api/quotesV2" },
{ "source": "/api/fulfill/v2", "destination": "/api/fulfillV2" }
```
**Actual files:**
```
api/quotes/v2.ts   → Vercel function path: /api/quotes/v2
api/fulfill/v2.ts  → Vercel function path: /api/fulfill/v2
```
Vercel automatically maps `api/quotes/v2.ts` to the path `/api/quotes/v2`. The rewrite destination `/api/quotesV2` maps to a non-existent `api/quotesV2.ts`. The rewrite is both redundant (Vercel handles the path automatically) and broken (wrong destination name). **Every V2 quote and fulfill call will 404 on Vercel.**
**Fix:** Remove the two broken rewrite rules from `vercel.json`. Vercel's filesystem routing already handles `api/quotes/v2.ts` → `/api/quotes/v2` without any rewrite rule.
**Test required:** `curl -X POST https://arc-budgetrail.vercel.app/api/quotes/v2` should return 400 (not 404) after fix.

#### P0-ENV-LEAK: Internal error messages expose env var names to browser
**File:** `api/quotes.ts` line 34, `api/fulfill.ts` line 34, `api/health.ts`
**Severity:** P0 for production (low for testnet).
**Finding:** `catch (e) { res.status(500).json({ error: (e as Error).message }) }` — when `loadConfig()` throws "Missing required env variable: QUOTE_SIGNER_PRIVATE_KEY", that exact string is returned to the browser.
**Fix:** Replace the catch body with a generic message: `res.status(500).json({ error: "Internal server error" })` and log the real error server-side only.

---

### P1 — High (must fix before public launch)

#### P1-SERIALIZE: `serializeEvent` does not convert bigints to strings before JSON.stringify
**File:** `src/lib/historyScanner.ts` lines 191-206
**Severity:** P1 — history checkpoint fails silently on any session with large numeric fields.
**Finding:** `serializeEvent` spreads the event and reassigns the same bigint values without converting to string. When `JSON.stringify` runs on line 163, bigint fields throw `TypeError: Do not know how to serialize a BigInt`. This means `saveCheckpoint` silently fails (caught by the outer `try/catch { /* storage unavailable */ }` at line 164). The checkpoint is never saved; every History page load re-scans all blocks from the deploy block.
**Proof:** `JSON.stringify(BigInt(1))` throws in all JS runtimes. The spread `{ ...e }` passes bigint values through unchanged.
**Fix:** In `serializeEvent`, convert every bigint field to `.toString()`: `sessionId: e.sessionId.toString()`, etc. The corresponding `deserializeEvent` already correctly reconstructs bigints with `BigInt(v)`.
**Test required:** `saveCheckpoint` with a non-empty events array; reload page; confirm `loadCheckpoint` returns non-null.

#### P1-AGENT-RACE: Agent session scan does not re-trigger on publicClient change
**File:** `src/pages/Dashboard.tsx` line 147
**Finding:** `useAgentSessions` effect depends on `[agent, publicClient]`. When the user switches wallets, `agent` changes → the guard `if (prevAgent.current === agent.toLowerCase()) return` is skipped → scan restarts correctly. However if `publicClient` changes independently (chain switch, reconnect) without `agent` changing, the scan does not restart. This is a minor race but can leave the agent section stale after a reconnect.
**Severity:** P1 minor. In practice wallets change together with the client.
**Fix:** Reset `prevAgent.current = undefined` inside the effect when `publicClient` changes, so the next `agent` reference triggers a fresh scan.

#### P1-DASHBOARD-HARDCODE: `arcTestnet` imported directly in Dashboard, bypassing arcProfile
**File:** `src/pages/Dashboard.tsx` line 10
**Finding:** `import { arcTestnet } from "viem/chains"` and `const CHAIN_ID = arcTestnet.id` hardcodes chain 5042002. If the app is ever pointed at mainnet (`VITE_ARC_NETWORK=mainnet`), the Dashboard will still scan testnet. The arcProfile system in `src/lib/arcProfile.ts` exists precisely to avoid this.
**Fix:** Replace with `import { getArcProfile } from "@/lib/arcProfile"` and `const CHAIN_ID = getArcProfile().chainId`.

#### P1-V2-REQUESTID-GLOBAL: V2 uses global requestId uniqueness but backend docs describe per-session
**File:** `contracts/BudgetRailV2.sol` lines 94-95, `346-347`
**Finding:** V2 stores `keccak256(abi.encodePacked(sessionId, requestId))` as the global replay key — this is actually per-session uniqueness keyed by (sessionId, requestId) pair, not a truly global requestId. The comment at line 94 says "global (not per-session) uniqueness check" but `sessionId` is included in the key, making it effectively per-session. This is not a security flaw — it is stricter than V1 (which used `_requestPaid[sessionId][requestId]` — same semantic). The comment is misleading but the implementation is correct.
**Fix:** Update comment only. No code change needed.

#### P1-V2-TYPEHASH-MISSING-REQUESTHASH: V2 signed struct does not include requestHash
**File:** `contracts/BudgetRailV2.sol` lines 70-73
**Finding:** The V2 `PaymentQuoteV2` typehash is:
```
PaymentQuoteV2(uint256 sessionId,bytes32 requestId,uint256 baseAmount,uint256 feeAmount,
uint256 grossAmount,uint256 deadline,address provider,address treasury)
```
It does NOT include `requestHash`. V1's typehash DOES include `requestHash` — a hash of the actual document content that binds the signature to specific input bytes. Without `requestHash` in V2, the signer D signs a quote for `(sessionId, requestId, amount, ...)` but not for specific content. The same signature could theoretically be used to fulfill with different content than what was priced (if the provider delivers a wrong result, there is no onchain proof of what was requested).
**Severity:** P1 security. The quote is not content-bound in V2.
**Fix:** Add `bytes32 requestHash` to `PaymentQuoteV2` typehash and to `payForRequestV2` function signature. Update V2 backend `eip712.ts` to compute and include requestHash. This is a breaking change to the V2 contract — requires redeployment.
**Note:** V1 is not affected. V2 is not deployed. Fix before V2 testnet deployment.

---

### P2 — Medium (fix before mainnet, acceptable for testnet demo)

#### P2-CORS-WILDCARD: Provider `allowedOrigin` defaults to `"*"` for local dev
**File:** `provider/src/lib/config.ts` line 71
**Finding:** `const allowedOrigin = optionalEnv("ALLOWED_ORIGIN", "*")` — if `ALLOWED_ORIGIN` is not set in Vercel, CORS is open to all origins. On Vercel this is currently set correctly. Risk is only on misconfigured deployments.
**Fix:** Change default from `"*"` to `""` and throw if not set in production (when `PROVIDER_NETWORK=mainnet`).

#### P2-EVIDENCE-INCOMPLETE: testnet.json lifecycle fields all null
**File:** `evidence/testnet.json`
**Finding:** The 6-step V1 testnet lifecycle has not been executed and documented. Session 22 exists onchain but is not recorded here.
**Fix:** Operator action — manually execute the lifecycle steps and populate the file.

#### P2-MAINNET-CHAIN-WIRED: src/config.ts includes mainnet for ENS but no guard prevents mainnet wallet ops
**File:** `src/config.ts`
**Finding:** `chains: [arcTestnet, mainnet]` — mainnet is included for ENS resolution. This means a connected wallet could be on mainnet. No guard in the UI prevents a user from submitting a transaction on mainnet if they switch their wallet to it.
**Fix:** Add `NetworkGuard` check in CreateBudget and Playground that blocks submissions when `chainId !== ARC_TESTNET_CHAIN_ID` (and blocks V2 submissions when V2 is not deployed).

---

### P3 — Low (cleanup, not blocking)

#### P3-DEPLOY-BLOCK-DUPLICATION: DEPLOY_BLOCK defined in two places
**File:** `src/lib/budgetRail.ts` and `src/pages/Dashboard.tsx` line 76
**Finding:** `DEPLOY_BLOCK = 67_538_363n` is defined inline in Dashboard.tsx AND exported from budgetRail.ts as `DEPLOY_BLOCK_TESTNET`. Dashboard.tsx uses its own inline copy, not the export.
**Fix:** Remove inline copy from Dashboard.tsx, import `DEPLOY_BLOCK_TESTNET` from `@/lib/budgetRail`.

#### P3-SESSION-COUNT-DRIFT: ownerSessionCount returns total but session IDs include deleted/closed sessions
**File:** `src/pages/Dashboard.tsx` useOwnerSessions hook
**Finding:** Minor — `ownerSessionCount` returns all sessions ever created, including closed ones. Pagination correctly shows closed sessions. No bug, just a UX note: "Session count" shown to users includes closed sessions.

---

## 7. Backup Instructions

To create a safe checkpoint before any future code changes:

```bash
# 1. Stage all tracked changes (secrets are gitignored, safe to run)
cd /home/user/app
git add -A

# 2. Create a local commit (does NOT push — safe)
git commit -m "chore: audit baseline checkpoint oct25 — before part01 fixes"

# 3. Verify no secrets were staged
git diff HEAD~1 --name-only
# Confirm: no .env files, no provider/.env, no recovery_file.dat

# 4. Optional: create a branch
git checkout -b audit-oct25-baseline
git checkout main  # return to main
```

The `.gitignore` correctly excludes: `.env`, `.env.*`, `*/.env`, `*/.env.*`, `provider/.env`, `agent/agent.env`, `env.example.txt`, `provider/env.example.txt`, `contracts/out/`, `contracts/cache/`, `console.jsonl`, `traces.jsonl`.

---

## 8. Status Table

| Item | Status | Priority |
|---|---|---|
| V1 onchain verification | PASS — all reads match source | — |
| V1 ABI matches source | PASS | — |
| V1 function names correct (payForRequest, not pay()) | CONFIRMED | — |
| V1/V2 separate create/fund (not combined) | CONFIRMED | — |
| V2 not deployed | CONFIRMED | — |
| Mainnet not deployed | CONFIRMED | — |
| `vercel.json` V2 rewrites broken (404) | DEFECT | P0 |
| API catch exposes env var names | DEFECT | P0 (prod) |
| `serializeEvent` BigInt JSON crash (silent) | DEFECT | P1 |
| Agent scan race on publicClient change | DEFECT | P1 minor |
| Dashboard hardcodes arcTestnet | DEFECT | P1 |
| V2 typehash missing requestHash | DEFECT | P1 security |
| CORS wildcard default | DEFECT | P2 |
| testnet.json lifecycle empty | PENDING | P2 operator |
| Mainnet NetworkGuard missing | DEFECT | P2 |
| DEPLOY_BLOCK defined twice | CLEANUP | P3 |
| Secrets gitignored | PASS | — |
| Secret values absent from source | PASS | — |

---

## 9. Recommended Fix Order

1. **P0-V2-REWRITE** — Fix `vercel.json` rewrites (2-line change, no logic). Redeploy.
2. **P0-ENV-LEAK** — Sanitise 500 error bodies in all api/ functions. Redeploy.
3. **P1-SERIALIZE** — Fix `serializeEvent` bigint-to-string conversion. History caching will then work.
4. **P1-V2-TYPEHASH** — Add `requestHash` to V2 typehash and `payForRequestV2`. Must be done BEFORE V2 testnet deployment.
5. **P1-DASHBOARD-HARDCODE** — Replace arcTestnet import with arcProfile in Dashboard.
6. **P1-AGENT-RACE** — Fix publicClient change not resetting agent scan.
7. **P2-CORS** — Harden ALLOWED_ORIGIN for mainnet.
8. **P2-MAINNET-GUARD** — Add NetworkGuard to CreateBudget and Playground.
9. **P2-EVIDENCE** — Operator: execute V1 testnet lifecycle, populate evidence/testnet.json.

---

## 10. Part 01 Acceptance Gates

Before Part 01 (fixes) is considered complete, all of the following must be true:

- [ ] `vercel.json` V2 rewrite destinations removed; `/api/quotes/v2` returns 400 not 404 on POST
- [ ] All `api/*.ts` catch blocks return `{ error: "Internal server error" }` only
- [ ] `serializeEvent` converts all bigint fields to strings; `saveCheckpoint` + `loadCheckpoint` round-trip verified
- [ ] V2 `PaymentQuoteV2` typehash includes `bytes32 requestHash`; `payForRequestV2` accepts and verifies it
- [ ] `Dashboard.tsx` imports chain ID from arcProfile, not hardcoded arcTestnet
- [ ] `bun run check` (lint + typecheck) reports 0 errors
- [ ] All existing tests pass (Foundry 60/60, provider 108/108, SDK 66/66, frontend 27/27)
- [ ] V1 contract `0xf6a13df15ad93c2e2968e1d69c53894a923bda21` remains unchanged onchain
- [ ] No new private key or secret value appears in any committed file

**STOP — awaiting approval before Part 01 implementation.**
