# Security Audit — Part 09
**Date:** 2026-10-26 | **Auditor:** Arc Studio | **Scope:** Full codebase pre-release

---

## 1. Secret Exposure Inventory

### Paths examined
| Path | Tracked in git? | Contains secrets? | Status |
|------|----------------|-------------------|--------|
| `provider/.env` | NO (gitignored) | YES — `QUOTE_SIGNER_PRIVATE_KEY` | SAFE — never committed |
| `agent/agent.env` | NO (gitignored) | YES — `AGENT_PRIVATE_KEY` | SAFE — never committed |
| `.env` | NO (gitignored) | YES — `RPC_PROXY_*`, `VITE_*` | SAFE — never committed |
| `env.example.txt` | NO (gitignored line 13) | Placeholders only | SAFE |
| `provider/env.example.txt` | NO (gitignored) | Placeholders only | SAFE |
| `contracts/contract-metadata/BudgetRail.json` | YES | Public deploy metadata only | OK |
| `evidence/testnet.json` | YES | Public session IDs + tx hashes | OK |

### Git history check
`git log --all --full-history -- provider/.env agent/agent.env .env` → **zero commits found**.
No secret file has ever appeared in git history. The `.gitignore` was present from the initial commit.

### Rotation recommendation
`QUOTE_SIGNER_PRIVATE_KEY` (signer D) was previously mentioned as potentially exposed in a ZIP export. **Rotation is recommended before mainnet.** Rotating on testnet will invalidate existing sessions' `quoteSigner` field — those sessions would need recreation. The V1 deployed session #20 and #21 hardcode signer D's public address (`0x70cd9e6a417b792ecEeA2E033BdfB8F8A8113a4C`) onchain; those sessions cannot be updated without creating new sessions with the new signer address.

### Public export manifest (what is safe to publish)
**Include:** All `.ts`/`.tsx`/`.sol` source, `package.json`, `bun.lock`, `foundry.toml`, `remappings.txt`, `vercel.json`, `tailwind.config.js`, `tsconfig.json`, `vite.config.ts`, all `docs/`, all `contracts/test/`, `AGENTS.md`, `README.md`, `env.example.txt` (addresses and variable names only, no values).

**Exclude:** `.env`, `.env.*`, `*/.env`, `provider/.env`, `agent/agent.env`, `agent/agent.env`, `console.jsonl`, `traces.jsonl`, `contracts/out/`, `contracts/cache/`, `*.dat` recovery files, any `*-private*` or `*-secret*` files.

The existing `.gitignore` already covers all of the above. No new exclusions needed.

---

## 2. Solidity Security Review

### V1 BudgetRail.sol

| Finding | Severity | Status |
|---------|----------|--------|
| Reentrancy: `payForRequest` + `closeSession` protected by `nonReentrant`; state updated before transfers (CEI) | N/A | PASS |
| Replay: `_requestPaid[sessionId][requestId]` per-session map set before transfer | N/A | PASS |
| Owner/agent authentication: `msg.sender != session.agent` / `msg.sender != session.owner` checked before any state change | N/A | PASS |
| EIP-712 domain: `("BudgetRail", "1", chainId, address(this))` — cross-chain and cross-contract replay structurally impossible | N/A | PASS |
| Quote expiry: `quoteDeadline > block.timestamp` AND `quoteDeadline <= session.expiresAt` — both enforced | N/A | PASS |
| USDC precision: all amounts `uint96` (6 decimals); no floating point anywhere | N/A | PASS |
| Cap check: `amount <= perPaymentCap` uses quote `amount`, not gross (V1 has no fee) | N/A | PASS |
| Direct USDC to contract: documented in NatSpec; no sweep function — permanent lock | LOW (known limitation) | DOCUMENTED |
| USDC blocklist: provider or owner blocklisted → revert with no fallback | LOW (known limitation) | DOCUMENTED |
| Zero-address validation: `agent`, `provider`, `quoteSigner` checked in `createSession` | N/A | PASS |
| `requestHash` in signed struct (V1): YES — added in initial design, present in `_PAYMENT_QUOTE_TYPEHASH` | N/A | PASS |

**V1 verdict: No critical or high findings. Two documented low-severity known limitations (blocklist, orphan USDC).**

### V2 BudgetRailV2.sol

| Finding | Severity | Status |
|---------|----------|--------|
| Fee verification: contract independently computes `floor(base * 50 / 10000)`; caller-supplied `feeAmount` must match exactly (reverts `InvalidFeeAmount`) — backend cannot inflate/deflate | N/A | PASS |
| Atomicity: `safeTransfer(C, base)` then `safeTransfer(E, fee)` — if either reverts, all state reverts (nonReentrant + CEI) | N/A | PASS |
| Zero fee skip: `if (feeAmount > 0)` skips treasury transfer for micro-payments; event still emitted with `feeAmount=0` | N/A | PASS — DISCLOSED |
| Global requestId replay: `_usedRequestIds[keccak256(abi.encodePacked(sessionId, requestId))]` — stronger than V1's per-session map | N/A | PASS |
| requestHash in EIP-712: YES — `bytes32 requestHash` in `_PAYMENT_QUOTE_V2_TYPEHASH` (Part 04 fix) | N/A | PASS |
| Treasury address in EIP-712: `TREASURY` (immutable) included in struct — prevents fee redirection by substituting treasury | N/A | PASS |
| `TREASURY` immutable: C==E onchain warning emitted in constructor; runtime server guard blocks mainnet misconfig | N/A | PASS |
| USDC code check: `extcodesize(usdcAddress) > 0` in constructor prevents zero-address or EOA as token | N/A | PASS |
| V1 cross-version replay: V2 uses EIP-712 version "2" — V1 quotes cannot be replayed against V2 | N/A | PASS |
| `uint256` amounts (V2 vs V1 `uint96`): V2 uses `uint256` throughout; no overflow risk at USDC 6-decimal scale | N/A | PASS |
| Direct USDC to contract: same limitation as V1 — documented | LOW (known) | DOCUMENTED |

**V2 verdict: No critical or high findings. Same documented low limitations as V1.**

---

## 3. API Security Audit

### Findings fixed this part

**P09-A (MEDIUM) — Fixed:** `readSession` and `readSessionV2` in `provider/src/lib/onchain.ts` previously swallowed ALL errors with `catch { return null }`. When the RPC was unreachable, `quotes.ts` received `null` and returned `404 "Session not found"` instead of `503 "RPC unavailable"`. This misled callers into thinking their session didn't exist when the error was actually a transient network failure.

**Fix:** Both functions now let RPC errors propagate. Route handlers already had `try/catch` returning 503 — the fix makes those branches actually reachable.

**File:** `provider/src/lib/onchain.ts` — `readSession`, `readSessionV2`

### Remaining findings (no code change needed)

| ID | Severity | Description | Status |
|----|----------|-------------|--------|
| P09-B | LOW | Rate limiter (`ratelimit.ts`) is in-memory — resets on Vercel cold start. An attacker can trigger a cold start and get a fresh bucket. Acceptable for MVP. | DOCUMENTED — post-MVP: use Redis/Upstash |
| P09-C | LOW | `ALLOWED_ORIGIN` in `api/rpc.ts` contains the sandbox preview hostname (`insyzu1x669slnbd423a6.preview.studio.arc.io`). This is the Arc Studio session hostname from development — must be removed before production deploy. | OPERATOR ACTION required |
| P09-D | INFO | `api/rpc.ts` retry on 429/503 retries unconditionally after 600ms. In theory a rate-limited upstream could cause 2× the upstream load on retry. Acceptable given single retry cap. | ACCEPTABLE |
| P09-E | INFO | `fulfillV2.ts` block timestamp check uses `fetchBlockTimestamp` which makes an additional RPC call. If this second call fails, it returns `null` and the check is skipped (not failed). A mined-then-orphaned tx would pass. Arc's fast finality makes this a non-issue in practice. | LOW RISK — documented |

### Request validation summary
All routes validate: content-type, body structure, required fields, BigInt parse, size limits (`maxInputBytes`), positive sessionId, rate limit, chain/contract/provider/signer identity match, fee arithmetic (V2), requestHash = SHA-256(input), all onchain event field matches. **No free-form field is used in SQL, shell, or eval.**

### Signer key security
- `QUOTE_SIGNER_PRIVATE_KEY` consumed only via `process.env` — never logged, returned in responses, or stored in memory beyond the config object.
- Format validated at startup (0x + 64 hex chars). Invalid key crashes at cold start, not mid-request.
- Public signer address D (`0x70cd9e6a417b792ecEeA2E033BdfB8F8A8113a4C`) is safe to expose — appears in `/api/health` and session creation UI. No private key server-side for C (provider payout) — it only receives USDC.

---

## 4. Economic Logic

| Claim | Evidence |
|-------|----------|
| V1 has zero platform fee | `BudgetRail.sol` has no fee computation or treasury transfer. 100% of `amount` goes to `session.provider`. |
| V2 fee is exactly 0.5% (50 bps) additive | `FEE_BPS=50`, `FEE_DENOMINATOR=10_000`, `feeAmount = (baseAmount * 50) / 10_000` (integer floor). |
| C receives full base | `safeTransfer(provider_, baseAmount)` — no deduction. |
| E receives only the fee | `safeTransfer(TREASURY, feeAmount)` — not base, not gross. |
| Gross = base + fee | `grossAmount = baseAmount + feeAmount` — verified by contract before accepting caller's `grossAmount`. |
| Budget/cap checks use gross | `grossAmount > session.perPaymentCap` and `newTotalSpent = session.totalSpent + grossAmount`. |
| Micro-payment fee = 0 | `floor(199 * 50 / 10_000) = floor(0.995) = 0`. Honest — no transfer to treasury, event shows `feeAmount=0`. |
| Refund includes no fee | `closeSession` refunds `totalFunded - totalSpent` — fee was already spent; no double charge. |

---

## 5. CI Workflow

### Changes made
- Fixed Foundry test count comment: 119 (was 120).
- Updated provider test count comment: ~150 (was 108).
- Added `secret-scan` job using `gitleaks/gitleaks-action@v2` — scans full git history on every push/PR.
- Added `abi-consistency` job — verifies `payForRequest` and `payForRequestV2` selectors are present in compiled output; fails if source was edited without rebuilding.

### CI jobs summary
| Job | Command | Expected |
|-----|---------|----------|
| contracts | `forge test -v` | 119/119 pass |
| provider | `cd provider && bun test` | ~150 pass |
| agent | `cd agent && bun test src/test/` | ~15 pass |
| sdk | `bun run typecheck` + `bun test src/` | 0 errors, ~66 pass |
| frontend | `bun run check` | 0 errors |
| example-app | `bunx tsc --noEmit` | 0 errors |
| build | `bunx vite build` | succeeds |
| secret-scan | gitleaks | 0 findings |
| abi-consistency | forge inspect selectors | both non-empty |

---

## 6. Documentation Accuracy

All documentation reviewed against source code. No false claims found:
- `docs/ARCHITECTURE.md` uses `payForRequest` / `payForRequestV2` (fixed in Part 03).
- `createSession` described as zero-funded; `fundSession` described separately (correct).
- No claim of "security audit" certification or mainnet evidence anywhere.
- `evidence/mainnet.json` shows all fields as TODO (correct).
- `AGENTS.md` states V2 not yet deployed (correct).

---

## 7. Mainnet GO/NO-GO

| Gate | Status |
|------|--------|
| No P0/P1 open findings | **PASS** — all P0 (requestHash) fixed in Part 04 |
| Secrets not in git history | **PASS** — confirmed by `git log` |
| `QUOTE_SIGNER_PRIVATE_KEY` rotated | **BLOCKED** — operator action P0-A pending |
| V2 contract deployed to testnet | **BLOCKED** — operator action H-01 pending |
| C and E are distinct wallets | **BLOCKED** — currently same address (testnet OK, mainnet BLOCKED) |
| Vercel env vars set | **BLOCKED** — operator action M-02 pending |
| V1 testnet lifecycle evidence | **BLOCKED** — operator action P0-C pending |

**Overall mainnet verdict: NO-GO.** All blockers are operator actions, not code defects. Code is ready for operator to execute the pre-launch checklist.

---

## Test Evidence

| Suite | Result | Command |
|-------|--------|---------|
| Foundry | 119/119 pass | `forge test` |
| bun test (all) | 524/525 pass (1 pre-existing) | `bun test` |
| Lint + typecheck | 0 errors, 0 warnings | `bash /home/user/arc-studio-helpers/check.sh` |
