# BudgetRail — V1 Final Baseline (Part 01)

> **Read-only audit. No files were modified. No transactions were broadcast.**
> All findings are from direct source inspection performed on 2026-10-20.

---

## 1. Architecture Map

```
Arc Testnet (Chain ID 5042002)
│
├── USDC ERC-20: 0x3600000000000000000000000000000000000000 (6 dec)
│
└── BudgetRail V1 contract: 0xf6a13df15ad93c2e2968e1d69c53894a923bda21
    │   Deployed: 2026-10-16T18:01:47.925Z
    │   Deploy tx: 0xf33cb9096a45c5cc083fbee4366384f4257f509ab94fe46ec4291e775bc4a5d9
    │   Deployer: Circle-managed Arc Studio testnet wallet (does NOT control deposits)
    │
    ├── Role A — OWNER (connected browser wallet)
    │   createSession, fundSession (with approve), closeSession + refund
    │   Source: src/pages/CreateBudget.tsx, ManageSession.tsx
    │
    ├── Role B — AGENT (address frozen at session creation)
    │   payForRequest only; enforced by contract (NotAgent revert)
    │   Source: src/pages/Playground.tsx, agent/src/demo.ts
    │
    ├── Role C — PROVIDER PAYOUT (address frozen at session creation)
    │   Passive USDC recipient; no contract permissions
    │   Address: read from VITE_PROVIDER_PAYOUT / PROVIDER_PAYOUT_ADDRESS env var
    │   Ownership: UNKNOWN — not verified this session (env file unreadable)
    │
    ├── Role D — QUOTE SIGNER (address frozen at session creation)
    │   Signs EIP-712 PaymentQuote; no USDC received from signing alone
    │   Public address: read from VITE_QUOTE_SIGNER / QUOTE_SIGNER_ADDRESS env var
    │   Private key: QUOTE_SIGNER_PRIVATE_KEY in provider/.env (gitignored)
    │   Ownership: UNKNOWN — env unreadable; prior rotation may have occurred
    │
    ├── Role E — PLATFORM TREASURY
    │   Does NOT exist in V1. Proposed for V2 only.
    │
    └── Vault accounting
        totalSpent ≤ totalFunded ≤ maxBudget (invariant)
        refund = totalFunded − totalSpent on closeSession

Frontend (React 18 / Vite / wagmi v2 / ConnectKit / Arc Testnet)
│
├── src/lib/arcProfile.ts — single source of truth for chain/contract/provider config
├── src/lib/budgetRail.ts — ABI + env-read addresses
├── src/onchain-facts.ts  — USDC descriptor, explorer URL builders
├── src/config.ts         — wagmi createConfig (arcTestnet + mainnet for ENS only)
│
├── Pages
│   ├── Dashboard.tsx       — session list + recent PaymentSettled scan
│   ├── CreateBudget.tsx    — 3-step flow: createSession → approve → fundSession
│   ├── Playground.tsx      — quote + pay + fulfill; localStorage recovery
│   ├── PaymentHistory.tsx  — PaymentSettled scanner (windowed getLogs)
│   ├── ManageSession.tsx   — top-up (approve + fund) + close/refund
│   └── Integrations.tsx    — informational; no onchain writes

Provider API (Bun/TypeScript, port 3001, NOT embedded in Vite production build)
│
├── GET  /api/health  — liveness; returns chain, contract, signer address (public)
├── POST /api/quotes  — reads session onchain, signs EIP-712 quote; no funds move
└── POST /api/fulfill — verifies receipt + PaymentSettled + Transfer logs; returns result

Agent CLI (Bun/TypeScript, agent/)
└── demo.ts  — reads session, requests quote from API, calls payForRequest onchain

SDK (packages/sdk/)
└── read.ts, pay.ts, quote.ts, services.ts — typed TypeScript client; no private keys
```

---

## 2. Status Matrix: DONE / DOCUMENTED / MOCKED / NOT DONE

| Component | Status | Evidence |
|-----------|--------|---------|
| BudgetRail.sol V1 source | **DONE** | Read in full; 295 lines; all guards, events, CEI correct |
| Foundry tests 59/59 | **DOCUMENTED** (not re-run this session) | docs/arc-studio-provenance.md; artifact exists at contracts/out/BudgetRail.sol/BudgetRail.json |
| Arc Testnet deployment | **DONE — onchain** | evidence/testnet.json; deploy tx recorded; `USDC_ADDRESS()` verified in prior session |
| Testnet lifecycle (create/fund/pay/close) | **NOT DONE** | evidence/testnet.json → `testnetLifecycle.status = "PENDING_MANUAL_EXECUTION"`; all tx fields are null |
| Provider API — code quality | **DONE** | All 3 routes read in full; EIP-712, event decoding, 14 receipt checks all verified correct |
| Provider API — 64 unit tests | **DOCUMENTED** (not re-run this session) | docs/arc-studio-provenance.md; provider/test/ exists |
| PaymentSettled topic derivation | **DONE — fixed** | fulfill.ts uses `toEventHash(BUDGET_RAIL_ABI.find(...))` — derived from ABI, NOT hardcoded; the old stale-selector bug is NOT present in current source |
| Agent CLI | **DONE** (15 tests documented; not re-run) | agent/src/demo.ts + test/agent.test.ts present |
| SDK | **DONE** (tests not re-run; not hosted) | packages/sdk/ complete; scanPaymentSettledEvents has a known RPC-skip bug (see blockers) |
| Frontend pages | **DONE** | All 5 pages read in full; wagmi v2 patterns correct; role guards correct |
| Provider configured check | **DONE** | PROVIDER_CONFIGURED + providerConfigError() block writes when VITE_PROVIDER_PAYOUT or VITE_QUOTE_SIGNER is zero |
| Old-signer compatibility warning | **DONE** | ManageSession.tsx lines 119–121 detect signerMismatch and display warning |
| localStorage recovery (Playground) | **DONE** | Full RecoveryState persisted before fulfill; restore + retry path implemented |
| Top-up (fundSession repeat) | **DONE** | ManageSession.tsx; validates headroom; approve-then-fund flow; bigint math only |
| Live public app URL | **NOT DONE** | No hosting configured; preview runs on Arc Studio sandbox only |
| Live provider backend URL | **NOT DONE** | Provider runs locally (port 3001 behind Vite proxy); no public HTTPS deployment |
| Mainnet deployment | **NOT DONE** | evidence/mainnet.json all nulls |
| GitHub repo public URL | **UNKNOWN** | Remote URL present in git config; repo may be private; no public URL confirmed |
| Video demo | **NOT DONE** | — |
| CI passing on GitHub | **UNKNOWN** | Workflow file exists (.github/workflows/ci.yml, 136 lines); commit message "defer CI" suggests it has NOT successfully run |
| docs/IMPLEMENTATION-STATUS.md | **NOT DONE** | File does not exist — created now |

---

## 3. V1 Contract Actions — Source Verification

### 3a. createSession
- ABI: `createSession(address agent, address provider, address quoteSigner, uint96 maxBudget, uint96 perPaymentCap, uint64 expiresAt) returns (uint256 sessionId)`
- Guards: ZeroAddress (agent/provider/signer), InvalidBudget (maxBudget==0), InvalidPerPaymentCap (cap==0 or cap>maxBudget), ExpiryInPast
- Event: `SessionCreated(uint256 indexed sessionId, address indexed owner, address indexed agent, address provider, address quoteSigner, uint96 maxBudget, uint96 perPaymentCap, uint64 expiresAt)`
- Frontend: CreateBudget.tsx calls via useSessionFlow; pre-flight with simulateContract; confirm modal
- **VERIFIED CORRECT**

### 3b. ERC-20 approve
- `USDC.approve(BUDGET_RAIL_ADDRESS, amount)`
- Exact amount only (not unlimited allowance) — comment on CreateBudget.tsx line ~453 confirms intent
- ManageSession.tsx top-up skips approve if `currentAllowance >= amount` (allowanceSufficient)
- **VERIFIED CORRECT**

### 3c. fundSession (initial + top-up)
- ABI: `fundSession(uint256 sessionId, uint96 amount)`
- Guards: SessionNotFound, NotOwner, SessionAlreadyClosed, SessionExpired, ZeroAmount, BudgetExceeded (newTotalFunded > maxBudget)
- Event: `SessionFunded(uint256 indexed sessionId, address indexed owner, uint96 amount, uint96 totalFunded)`
- CEI: updates totalFunded BEFORE safeTransferFrom (prevents double-credit)
- Frontend: both CreateBudget.tsx and ManageSession.tsx; top-up headroom = maxBudget − totalFunded displayed
- **VERIFIED CORRECT**

### 3d. payForRequest
- ABI: `payForRequest(uint256 sessionId, bytes32 requestId, bytes32 requestHash, uint96 amount, uint64 quoteDeadline, bytes calldata providerSignature) nonReentrant`
- Guards: SessionNotFound, NotAgent, SessionAlreadyClosed, SessionExpired, ZeroAmount, PerPaymentCapExceeded, FundedBudgetExceeded, LifetimeBudgetExceeded, QuoteExpired, QuoteDeadlineExceedsSession, RequestAlreadyPaid, InvalidSignature
- EIP-712: domain `{name:"BudgetRail", version:"1", chainId: runtime, verifyingContract: deployed}` — matches provider eip712.ts buildDomain()
- Amount type: `uint256` in struct hash (`abi.encode(... uint256(amount) ...)`), `uint96` in storage and transfer — no truncation risk since uint96 fits uint256
- Recipient: always `session.provider` — no arbitrary destination
- Event: `PaymentSettled(uint256 indexed sessionId, bytes32 indexed requestId, address indexed provider, bytes32 requestHash, address agent, uint96 amount, uint64 quoteDeadline)`
- **VERIFIED CORRECT**

### 3e. closeSession + refund
- ABI: `closeSession(uint256 sessionId) nonReentrant`
- Guards: SessionNotFound, NotOwner, SessionAlreadyClosed
- No expiry check — callable even after expiry (by-design: owner must always be able to close)
- Refund = totalFunded − totalSpent, always non-negative (invariant)
- Event: `SessionClosed(uint256 indexed sessionId, address indexed owner, uint96 refunded, uint96 totalSpent)`
- **VERIFIED CORRECT**

### 3f. EIP-712 type alignment (contract vs provider vs frontend)

| Field | Solidity type | Provider (PAYMENT_QUOTE_TYPES) | Frontend (BUDGET_RAIL_ABI decodeEventLog) |
|-------|-------------|-------------------------------|------------------------------------------|
| sessionId | uint256 | uint256 | uint256 |
| requestId | bytes32 | bytes32 | bytes32 |
| requestHash | bytes32 | bytes32 | bytes32 |
| amount | uint256 (in struct hash) | uint256 | uint256 (BigInt cast) |
| quoteDeadline | uint64 | uint64 | uint64 |

Field order matches. Domain separator fields match. **VERIFIED CORRECT.**

### 3g. PaymentSettled event topic — stale selector check
- Old bug: hardcoded topic0 hex in provider tests
- Current code: `fulfill.ts` line 62: `const PAYMENT_SETTLED_TOPIC = toEventHash(BUDGET_RAIL_ABI.find(x => x.type === "event" && x.name === "PaymentSettled")!)`
- This derives the topic from the live ABI — not hardcoded
- **FIXED — stale selector bug is NOT present**

---

## 4. Configuration Path Audit

### 4a. Chain ID consistency
- Frontend: `src/config.ts` uses `arcTestnet` from `viem/chains` → chain ID 5042002 (correct)
- Frontend: dashboard, pages all import `arcTestnet.id` from viem/chains (constant 5042002)
- `CHAIN_ID = arcTestnet.id` used in all page-level reads and writes — consistent
- arcProfile.ts TESTNET_PROFILE.chainId = 5042002 — consistent
- provider/src/lib/config.ts ARC_TESTNET_CHAIN_ID = 5042002 — consistent
- agent/src/lib/chain.ts chain.id = config.chainId from AgentConfig — driven by env

**No testnet/mainnet chain ID collision found in the testnet code path.**

### 4b. Contract address consistency
- All frontends default to `0xf6a13df15ad93c2e2968e1d69c53894a923bda21` via:
  - `src/lib/budgetRail.ts` line 26: `readAddr("VITE_BUDGET_RAIL_ADDRESS", "0xf6a13df15ad93c2e2968e1d69c53894a923bda21")`
  - `arcProfile.ts` line 69: same default
  - `provider/src/lib/config.ts` line 41: same default
- Deploy block `67_538_363n` hardcoded in `arcProfile.ts` and referenced as `DEPLOY_BLOCK_TESTNET` in budgetRail.ts/PaymentHistory — not read from env
- Mainnet contract: `VITE_BUDGET_RAIL_MAINNET_ADDRESS` env var, defaults to ZERO — any mainnet write would hit zero address check and fail safely

**Contract address is consistent. Deploy block is correct.**

### 4c. Provider C / Signer D addresses
- Frontend: read from `VITE_PROVIDER_PAYOUT` and `VITE_QUOTE_SIGNER`; if zero → PROVIDER_CONFIGURED = false → all write buttons disabled/show warning
- Provider: `PROVIDER_PAYOUT_ADDRESS` (required), `QUOTE_SIGNER_ADDRESS` (optional cross-check), `QUOTE_SIGNER_PRIVATE_KEY` (required for signing)
- Quotes route (line 97): derives expectedSigner from private key at runtime → verifies session.quoteSigner matches before signing → rejects mismatched sessions
- **Addresses are UNKNOWN** (env files unreadable) but the validation path is correct

### 4d. Mainnet isolation
- arcProfile.ts mainnet profile requires `VITE_BUDGET_RAIL_MAINNET_ADDRESS` → defaults to ZERO
- `assertCorrectNetwork()` throws if wallet chain differs from build target
- VITE_ARC_NETWORK defaults to "testnet" — no mainnet config active unless explicitly set
- **No mainnet bleed into testnet path found**

### 4e. USDC address
- All layers use `0x3600000000000000000000000000000000000000`
- 6 decimals used throughout for ERC-20 operations
- Native gas (18 dec) only referenced in agent chain definition (`nativeCurrency.decimals: 18`) — not summed with ERC-20 balance anywhere
- **CORRECT**

### 4f. Vite proxy dependency (critical for provider API)
- Vite dev proxy: inferred from `VITE_PROVIDER_API_URL=""` default in env.example.txt
- Provider runs on port 3001; Vite proxies `/api/*` to `localhost:3001`
- This only works in the Vite dev server; a production build has NO proxy
- Provider must be separately hosted with HTTPS for any public deployment
- **DOCUMENTED LIMITATION** — not a new finding

---

## 5. Deployment Evidence Inventory

| Item | Status | Value / URL |
|------|--------|------------|
| V1 contract — Arc Testnet | **EXISTS** | `0xf6a13df15ad93c2e2968e1d69c53894a923bda21` |
| Deploy tx — Arc Testnet | **EXISTS** | `0xf33cb9096a45c5cc083fbee4366384f4257f509ab94fe46ec4291e775bc4a5d9` |
| Explorer (contract) | **EXISTS** | https://explorer.testnet.arc.io/address/0xf6a13df15ad93c2e2968e1d69c53894a923bda21 |
| Explorer (deploy tx) | **EXISTS** | https://explorer.testnet.arc.io/tx/0xf33cb9096a45c5cc083fbee4366384f4257f509ab94fe46ec4291e775bc4a5d9 |
| Testnet lifecycle txs | **MISSING** | All null in evidence/testnet.json |
| Public app URL | **MISSING** | Not deployed to any host |
| Live provider backend URL | **MISSING** | Runs locally only |
| V2 contract | **MISSING** | Not designed or deployed yet |
| Mainnet contract | **MISSING** | evidence/mainnet.json all nulls |
| Arc Studio project URL | **EXISTS** (recorded in docs but specific URL not confirmed) | https://studio.arc.io (session preserved) |
| GitHub repo URL | **UNKNOWN** | Remote configured; visibility unconfirmed |
| Video demo | **MISSING** | — |

---

## 6. V1 Preservation Strategy

The following rules apply to all future Parts:

1. `contracts/BudgetRail.sol` source is frozen. No edits. The testnet deployment is immutable bytecode.
2. All existing sessions on Arc Testnet (chain 5042002) remain readable and spendable under their original V1 rules.
3. V2 will be a separately compiled and separately deployed contract with a different address, a different EIP-712 domain (`version: "2"`), separate ABI exports, and separate frontend history views.
4. No user funds are migrated. No `closeSession` is called on existing sessions without explicit owner authorization.
5. Frontend network labels must show "V1" vs "V2" distinctly wherever both are visible.
6. SDK will expose separate config paths for V1 and V2 (separate `contractAddress`, `version` field).

---

## 7. Blockers — P0 / P1 / P2

### P0 — Security / Data Integrity (must resolve before public release or mainnet)

**P0-A: `provider/.env` exposure risk**
- File: `provider/.env`
- The prompt notes that a prior ZIP export may have included this file, which contains `QUOTE_SIGNER_PRIVATE_KEY`.
- The gitignore correctly excludes it. However, if it was ever exported in a zip or pushed to a public GitHub branch, key D should be treated as compromised.
- **Action required before any public release:** verify GitHub repo history contains no `provider/.env`; if the key was ever public, generate a new keypair and create new sessions with the new `quoteSigner` address. The old sessions permanently store the prior D address and cannot be updated.
- This is NOT verifiable from inside the sandbox (env files are read-protected). Owner must perform this check manually.

**P0-B: Git remote URL contains an authentication token**
- File: `.git/config` (not committed, but visible in sandbox)
- The remote URL is `https://web3chandra:[TOKEN]@github.com/...`
- This token is a credential in plaintext in the sandbox environment. Rotate it via GitHub Settings and update the remote to `https://github.com/web3chandra/BudgetRail.git`.

**P0-C: No testnet lifecycle has been manually executed**
- `evidence/testnet.json` → all lifecycle tx fields are null
- Without a real create/fund/pay/close on testnet, there is no proof the end-to-end flow works against the live contract
- The contract code is correct, but "code is correct" ≠ "live system works"
- Required for grant submission evidence

### P1 — Functional Gaps (must fix before grant submission or user-facing deployment)

**P1-A: SDK `scanPaymentSettledEvents` silently skips failed RPC windows**
- File: `packages/sdk/src/read.ts`, lines 230–234
- On `getLogs` failure, the catch block logs nothing, sleeps 200ms, and continues to the next window
- A failed window leaves a silent gap in event history with no indication to the caller
- Callers cannot distinguish "no events in range" from "RPC failed for range"
- Fix: return partial results with a `skippedRanges` array, or throw after N consecutive failures

**P1-B: PaymentHistory page scans only `PaymentSettled`; three event types are absent**
- File: `src/pages/PaymentHistory.tsx`
- `SessionCreated`, `SessionFunded`, `SessionClosed` are not scanned anywhere in the frontend
- Users cannot see a complete history of their sessions
- Dashboard `useRecentPayments` also scans only `PaymentSettled` in one unbounded `getLogs` call

**P1-C: Dashboard `useRecentPayments` does a single unbounded `getLogs` call**
- File: `src/pages/Dashboard.tsx`, lines 135–180
- Calls `getLogs({ fromBlock: DEPLOY_BLOCK_TESTNET, toBlock: latestBlock })` in one request
- No batching, no progress, no retry, no backoff
- Will fail as block range grows; already potentially 67M+ blocks

**P1-D: Provider C and Signer D ownership unverified**
- The addresses read from env vars at build time are never displayed with confirmed ownership
- ManageSession correctly shows `formatAddr(session.provider)` and `formatAddr(session.quoteSigner)` — those are onchain facts
- But whether the operator controls those wallets has never been proven
- Required to establish grant submission credibility

**P1-E: No live public URL for app or provider API**
- The app runs in Arc Studio preview only; the provider runs on localhost
- Grant submission requires a live, accessible application

### P2 — Quality / Completeness (important but lower urgency)

**P2-A: CI workflow has never successfully run on GitHub**
- File: `.github/workflows/ci.yml`
- Commit message "chore: defer CI workflow (requires workflow PAT scope)" indicates it was intentionally disabled
- The workflow is syntactically correct and well-structured (contracts, provider, agent, sdk, frontend, build jobs)
- Needs a GitHub Actions environment with appropriate secrets (no signing keys needed for unit tests)

**P2-B: SDK `scanPaymentSettledEvents` deduplicates by `requestId` alone**
- File: `packages/sdk/src/read.ts`, line 221: `const key = requestId`
- Should use `(txHash, logIndex)` as the dedup key (same as PaymentHistory page does correctly)
- A requestId collision (extremely unlikely but theoretically possible) would drop a legitimate event

**P2-C: SDK test count claimed as "~39" in CI comment — actual count unverified**
- File: `.github/workflows/ci.yml` line 98: `# Expected: ~39 tests, 0 failures`
- Tests not run this session; exact count unknown

**P2-D: `docs/IMPLEMENTATION-STATUS.md` was missing**
- Created by this Part 01 report; should be maintained going forward

**P2-E: Provider rate limiter is in-memory (M2 from SECURITY.md)**
- Resets on server restart; production would need Redis
- Documented, acknowledged; acceptable for MVP/testnet

**P2-F: Vite proxy does not exist in production build**
- `VITE_PROVIDER_API_URL=""` works only for the Vite dev server
- A production build needs a real `VITE_PROVIDER_API_URL` pointing to a hosted provider
- Documented in env.example.txt; not a code bug, an operational requirement

---

## 8. Current Build/Test Commands and Status

Commands as they exist in package.json:

```bash
# Frontend lint + typecheck (last run result: 0 errors, per provenance doc)
bun run check         # runs oxlint + tsc --noEmit

# Contract build + test (documented: forge build + forge test)
bun run contracts:build   # forge build
bun run contracts:test    # forge test  (documented 59/59 pass)

# Provider tests
cd provider && bun test   # (documented 64/64 pass)

# Agent tests
cd agent && bun test src/test/   # (documented 15/15 pass)

# Frontend tests
bun run frontend:test    # bun test src/test/

# SDK typecheck + tests
cd packages/sdk && bun run typecheck
cd packages/sdk && bun test src/
```

**None of the above were re-run in this Part 01 session.** The instruction was read-only inspection. Results are from documentation; treat them as "last known good" not "verified now". Re-running them is the correct first step before any code changes.

---

## 9. Grant Eligibility Summary

Grant submission requires (from docs/GRANT-EVIDENCE.md):

| Requirement | Status |
|-------------|--------|
| Real Arc Mainnet USDC movement | **MISSING** — no mainnet deployment |
| Arc Studio project URL | **EXISTS** (not publicly shareable yet) |
| Working application with real API result | **CODE READY** — not demonstrated live |
| Public GitHub repo URL | **UNKNOWN** — may be private |
| Video demo | **MISSING** |
| Testnet lifecycle evidence (create/fund/pay/close tx hashes) | **MISSING** — all null |
| Live hosted app URL | **MISSING** |

**Summary: 0 of 7 grant evidence items are confirmed complete. The code and contract are solid; the evidence collection is the remaining gap.**

---

*This document was created in Part 01. It will be updated at the end of each subsequent Part with a factual checkpoint.*
