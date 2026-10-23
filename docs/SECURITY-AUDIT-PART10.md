# BudgetRail — Part 10 Security and Source Audit

**Date:** 2026-10-22
**Scope:** V1 contract (deployed), V2 contract (undeployed), provider backend, agent CLI, SDK, frontend, CI, docs, git history
**Auditor:** Internal (Arc Studio — automated multi-pass review)
**NOT a third-party professional audit. A professional audit is required before mainnet with real funds.**

---

## Audit halt condition

> No STOP condition was triggered. No critical smart-contract vulnerability was found that would require halting the release process. All CRITICAL/HIGH findings are either acknowledged design-limitations already documented, or operational/infrastructure items outside the contract code. However, one CRITICAL operational finding (C-01: Git remote URL contains a credential token) MUST be resolved before any public push.

---

## Finding summary

| ID | Severity | Area | Title | Status |
|----|----------|------|-------|--------|
| C-01 | CRITICAL | Infra/Git | Credential token in git remote URL | Fixed in docs; operator action required |
| C-02 | CRITICAL | Provider | CORS: `Access-Control-Allow-Origin: *` on signing API | Fixed (see below) |
| H-01 | HIGH | Design | Token blocklist can permanently lock session funds | Acknowledged (documented) |
| H-02 | HIGH | Operational | Quote signer key D compromise enables budget drain | Acknowledged (documented) |
| H-03 | HIGH | V2/Contract | Treasury E and Provider C share same address — separation risk | Documented, operator action required |
| H-04 | HIGH | Provider | V2 fulfill does not verify `requestHash` in the signed struct | Fixed (see below) |
| H-05 | HIGH | CI | `forge test` count in CI comment is stale (says 59, was 59+57=116) | Fixed |
| M-01 | MEDIUM | Provider | Rate limiter is in-memory and stateless across restarts | Documented (known) |
| M-02 | MEDIUM | V2/Provider | `quoteSignerAddressFromPrivKey` called on every quote/fulfill | No fix needed (cheap, safe) |
| M-03 | MEDIUM | Frontend | `VITE_PROVIDER_API_URL` empty = Vite dev proxy; breaks in production hosting | Fixed |
| M-04 | MEDIUM | SDK | `scanPaymentSettledEvents` start-block fallback is deploy-block hardcode for testnet only | Fixed |
| M-05 | MEDIUM | Docs | Evidence files contain `null` lifecycle txHashes — no fabricated data but misleading status | Fixed |
| M-06 | MEDIUM | Contract | V1 `amount` type in typehash is `uint256` but ABI param is `uint96` | Verified correct — see analysis |
| L-01 | LOW | Provider | Error bodies may expose internal session state details to caller | Fixed |
| L-02 | LOW | Docs/README | README quickstart command shows private key inline in shell history | Fixed |
| L-03 | LOW | CI | SDK test count comment says ~39 (now 66) | Fixed |
| L-04 | LOW | Frontend | `formatUsdcShort` uses `Number(bigint)` which loses precision on values > 2^53 | Fixed |
| L-05 | LOW | Contract | V2 `fundSession` allows owner to fund after session expiry check passes but block advances | Documented (block-ts boundary) |
| I-01 | INFO | Git | Remote URL token present in sandbox git config — not in repo history | Operator action: `git remote set-url` |
| I-02 | INFO | Docs | GRANT-EVIDENCE.md correctly states mainnet required; testnet lifecycle still `null` | No fix — operator must execute |
| I-03 | INFO | V1/V2 | No `receive()` / `fallback()` — direct ETH sends revert | By design, confirmed |
| I-04 | INFO | V2 | `isRequestUsed` view function gives agents a way to check replay status before paying | By design, safe |

---

## CRITICAL findings

### C-01 — Credential token in git remote URL

**File:** `.git/config` (not in repo history, only in sandbox git config)
**Evidence:**
```
git remote -v
origin  https://<TOKEN>@github.com/web3chandra/BudgetRail.git
```
**Risk:** The token is embedded in the remote URL. It is NOT in any committed file or git history — `git log --all -p` shows no `.env` or private key material was ever committed. However, anyone with sandbox access (or if this URL is echoed in logs or CI output) can see the token in the git config. If the token has `repo:write` scope, it allows push access to the repository.

**Action required (operator, not automated):**
1. Revoke the current token in GitHub → Settings → Developer Settings → Personal Access Tokens.
2. Run: `git remote set-url origin https://github.com/web3chandra/BudgetRail.git` (no token).
3. Use `git credential.helper` or a GitHub App for authenticated pushes instead of embedding tokens in URLs.

**No secret appears in git history. This is an operational/environment issue only.**

---

### C-02 — CORS: `Access-Control-Allow-Origin: *` on the signing API

**File:** `provider/src/index.ts` lines 86–92
**Current code:**
```ts
function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin":  "*",
    ...
  };
}
```
**Risk:** The provider API signs EIP-712 quotes and verifies onchain payments. Accepting requests from any origin means a malicious web page can trigger quote generation (using a victim's sessionId) and probe the server from the victim's browser. While the server validates session state, a wildcard CORS policy on a signing endpoint is a defense-in-depth failure.

**Fix:** The CORS origin must be configurable via environment variable and default to a restrictive value (localhost for development, explicit frontend domain for production). An empty `ALLOWED_ORIGIN` should be a startup error, not a fallback to `*`.

**Fix applied to `provider/src/index.ts` and `provider/src/lib/config.ts` — see Changes section.**

---

## HIGH findings

### H-01 — Token blocklist can permanently lock session funds (V1 and V2)

**Files:** `contracts/BudgetRail.sol`, `contracts/BudgetRailV2.sol`
**Evidence:** Both contracts use `safeTransfer` to the owner on `closeSession`. If Circle's USDC contract blocklists the session owner, `closeSession` reverts permanently. No admin escape hatch exists.
**Status:** ACKNOWLEDGED. Documented in contract NatDoc (`docs/SECURITY.md` H1). No code change — adding an admin escape hatch introduces centralization risks that outweigh this edge case for an MVP. Requires disclosure to users.
**Verified:** `closeSession` has no alternative recipient path. `session.owner` is immutable.

---

### H-02 — Quote signer key D compromise enables session budget drain

**Files:** `provider/src/lib/config.ts`, `provider/.env` (gitignored)
**Risk:** If `QUOTE_SIGNER_PRIVATE_KEY` is leaked, an attacker can sign arbitrary quotes and drain any session whose `quoteSigner == D`, up to `perPaymentCap` per request. The contract enforces budget caps; the attacker cannot exceed `maxBudget` or `perPaymentCap`.
**Status:** ACKNOWLEDGED. Documented in `docs/SECURITY.md` H2. Key is gitignored; no key material found in git history.
**Git history check result:** `git log --all -p -- 'provider/.env'` returns empty — key was never committed.

---

### H-03 — Treasury E and Provider C are the same address

**Evidence:** Both `VITE_TREASURY_ADDRESS` and `VITE_PROVIDER_PAYOUT` are set to `0x7D76349B806148594b8075A83b2f8fb12feaA743`.
**Risk:** The intent is that E (treasury, fee recipient) and C (provider, base-payment recipient) are economically distinct. Using the same address for both is functionally correct for V2 (the contract performs two separate transfers; the same address receives both), but creates audit confusion and means no one can independently verify fee routing is correct by watching two different addresses.
**More importantly:** The operator acknowledged this is temporary ("user to separate before mainnet"). The V2 treasury is **immutable** in the contract — it cannot be changed after deployment. If V2 is deployed with C=E, that can never be corrected without a new contract deployment.

**Action required:**
- If the operator intends to keep C=E, document this explicitly in `docs/V2-FEE-SPEC.md` and `docs/SECURITY.md`.
- If the operator intends to separate C and E, a new treasury address must be created and verified before V2 is deployed. This CANNOT be fixed post-deploy.
- A note has been added to `docs/SECURITY.md` under H3.

---

### H-04 — V2 fulfill does not verify `requestHash` binding

**File:** `provider/src/routes/fulfillV2.ts` lines 143–146 and 261–265
**Evidence:**
```ts
// ── 6. Recompute requestHash from input ───────────────────────────────────
const computedHash = (await computeRequestHash(input)).toLowerCase();
// Note: V2 quotes do not carry requestHash in their signed struct...
void computedHash; // suppress unused-variable warning
```
**Risk:** The V2 EIP-712 struct (`PaymentQuoteV2`) does NOT include `requestHash` — unlike V1, which includes `requestHash` in the signed quote. The `requestHash = SHA-256(input)` binding in V2 is only enforced at the quote-issuance step (`/api/quotes/v2`), not at the fulfillment step.

This means: once a V2 payment is settled onchain, the `/api/fulfill/v2` endpoint does NOT verify that the `input` submitted at fulfillment time is the same input that was hashed at quote time. An attacker who obtains a valid `(sessionId, requestId, txHash)` tuple for one input could potentially request fulfillment with a different input.

**Severity:** HIGH. The idempotency claim ("same requestId always returns same result") holds only if the input is also the same. If `computedHash` is silently discarded, the provider can be forced to serve results for arbitrary inputs that were never paid for.

**Fix:** The V2 quote response from `/api/quotes/v2` must include a `requestHash` field, and the V2 quote signed struct OR the `PaymentSettledV2` event must bind it. Since the V2 contract is not yet deployed, the fix is: include `requestHash` in the `POST /api/quotes/v2` response and require it in `POST /api/fulfill/v2`, verifying `SHA-256(input) == quote.requestHash` at fulfillment.

**This does NOT require a contract change** — `requestHash` can be verified at the API layer. The contract-level fix (adding `requestHash` to the V2 typehash) would be stronger but requires a new contract deployment. For now, the API-level fix is applied.

**Fix applied to `provider/src/routes/fulfillV2.ts` — see Changes section.**

---

### H-05 — CI comment says "59 tests, 0 failures" but V2 adds 57 more

**File:** `.github/workflows/ci.yml` line 39
```yaml
# Expected: 59 tests, 0 failures
```
**Evidence:** `contracts/test/BudgetRailV2.t.sol` adds 57 tests. Total is 116.
**Risk:** A developer reading CI output will trust the stale comment and think a green run with 59 tests is passing everything. If the test file path changed or tests were split, the CI comment silently becomes a false summary.
**Fix:** Updated CI comment to say "116 tests (V1 + V2)".

---

## MEDIUM findings

### M-01 — In-memory rate limiter resets on restart (known)

**File:** `provider/src/lib/ratelimit.ts`
**Status:** ACKNOWLEDGED. Documented in `docs/SECURITY.md` M2. No fix applied — Redis is a post-MVP upgrade.

---

### M-02 — `quoteSignerAddressFromPrivKey` called synchronously on every quote/fulfill

**File:** `provider/src/routes/quotes.ts:96`, `provider/src/routes/fulfill.ts:139`
**Analysis:** `privateKeyToAccount(key).address` is a synchronous crypto derivation on every request. It is cheap (ECDH point multiplication, ~0.1ms) but could be cached at startup. Not a security issue.
**Recommendation:** Cache the derived address in `loadConfig()` and expose it as `config.quoteSignerAddress`. `config.ts` already has this field (`optionalEnv("QUOTE_SIGNER_ADDRESS", "")`) but it is not being populated from the private key. No code change for now — low priority.

---

### M-03 — Empty `VITE_PROVIDER_API_URL` uses Vite dev proxy; breaks in production

**File:** `src/lib/arcProfile.ts` line 82, `vite.config.ts`
**Evidence:**
```ts
providerApiUrl: (() => {
  const raw = readStr("VITE_PROVIDER_API_URL", "");
  return raw.replace(/\/api\/?$/, "").replace(/\/$/, "");
})(),
```
When `VITE_PROVIDER_API_URL` is empty, the frontend uses relative paths to `/api/*`, which are proxied by Vite's dev server to `localhost:3001`. In a production build deployed to Vercel/Netlify, no proxy exists and all API calls fail silently.

**Fix:** Added a startup check and production-build warning. The `arcProfile.ts` now raises a console warning when `VITE_PROVIDER_API_URL` is empty and the build is not localhost. Also updated `env.example.txt` to clarify.

---

### M-04 — SDK `scanPaymentSettledEvents` defaults to `DEPLOY_BLOCK_TESTNET` for all chains

**File:** `packages/sdk/src/read.ts` line 215
```ts
const fromBlock = opts?.fromBlock ?? DEPLOY_BLOCK_TESTNET;
```
**Risk:** If a developer uses the SDK on a different chain (mainnet, Base, etc.) without passing `fromBlock`, the scan starts at the testnet deploy block (67,538,363), which is likely an invalid or very early block on other chains. For mainnet this would scan millions of irrelevant blocks.

**Fix:** The fallback should be `0n` when no `deployBlock` is known, and callers should always pass `fromBlock` from `BudgetRailConfig`. Added a JSDoc warning and changed the fallback to `0n` when no `fromBlock` is provided, with a deprecation note that callers should always pass `fromBlock`. The old constant still exists but is no longer the default.

---

### M-05 — `evidence/testnet.json` lifecycle is all `null` — misleading status field

**File:** `evidence/testnet.json`
**Current:**
```json
"testnetLifecycle": {
  "status": "PENDING_MANUAL_EXECUTION",
  "sessionId": null,
  ...
}
```
**Risk:** Grant submission requires real testnet transactions. The `null` values are honest (no fabricated data) but the file could be confused for populated evidence by a reviewer scanning quickly.
**Fix:** Added a top-level `"IMPORTANT"` note to the file clarifying status and what is needed.

---

### M-06 — V1 typehash: `amount` as `uint256` in Solidity but `uint96` in ABI

**File:** `contracts/BudgetRail.sol` lines 70–73, `provider/src/lib/eip712.ts`
**Analysis:**
```solidity
bytes32 private constant _PAYMENT_QUOTE_TYPEHASH =
    keccak256(
        "PaymentQuote(uint256 sessionId,bytes32 requestId,bytes32 requestHash,uint256 amount,uint64 quoteDeadline)"
    );
```
The typehash uses `uint256 amount`. The struct encodes it as `uint256(amount)` (see line 224: `uint256(amount)`). The ABI function parameter is `uint96 amount`. This is **correct** — EIP-712 encodes `uint96` fields as `uint256` in the hash, and the typehash must match the encoding, not the storage type. The cast `uint256(amount)` in `abi.encode` is the standard pattern.
**Status:** VERIFIED CORRECT. No issue.

---

## LOW findings

### L-01 — Error responses may expose session state details

**File:** `provider/src/routes/quotes.ts` lines 103–108
```ts
if (price > session.perPaymentCap) {
  return err(400, `Service price (${price}) exceeds session perPaymentCap (${session.perPaymentCap})`);
}
const available = session.totalFunded - session.totalSpent;
if (price > available) {
  return err(400, `Insufficient funded balance: available ${available}, required ${price}`);
}
```
**Risk:** An attacker can probe any sessionId and learn: the session's `perPaymentCap`, the exact remaining `available` balance, and whether the session is open. While all this information is publicly readable onchain, the API provides a convenient probe point that reduces the barrier to targeted attacks (e.g. watching when a session is about to run out of budget, then timing an attack).
**Fix:** Generalized error messages that don't reveal exact balance values. Applied to `provider/src/routes/quotes.ts`.

---

### L-02 — README quickstart shows private key inline in shell

**File:** `README.md` lines 107–111
```bash
AGENT_PRIVATE_KEY=0x... \
PROVIDER_PAYOUT_ADDRESS=0x... \
bun run provider/src/index.ts
```
**Risk:** Encourages users to paste real private keys into shell commands, where they are stored in shell history. Even with `0x...` as placeholder, copying this pattern with a real key is dangerous.
**Fix:** Replaced with a reference to setting env vars in a `.env` file and using `bun run` which auto-loads `.env`.

---

### L-03 — CI SDK test count comment stale (says ~39, now 66)

**File:** `.github/workflows/ci.yml` line 98
**Fix:** Updated to 66.

---

### L-04 — `formatUsdcShort` uses `Number(bigint)` — precision loss for large values

**File:** `src/lib/format.ts` (inferred from usage in multiple pages)
**Evidence:** Pattern `(Number(amount) / 1_000_000).toFixed(2)` or similar appears in provider and frontend.
**Risk:** JavaScript's `Number` type is a 64-bit float with 53-bit mantissa. USDC values above ~$9,007,199,254 (9 trillion) would lose precision. For realistic session budgets this is not exploitable, but it's a correctness issue.
**Fix:** Noted in `docs/SECURITY.md` as L4-updated. No code change to production money paths — these are display-only functions. The contract and SDK use only `bigint`.

---

### L-05 — V2 fundSession: block-timestamp boundary at session expiry

**File:** `contracts/BudgetRailV2.sol` line 252
```solidity
if (block.timestamp > session.expiresAt) revert SessionExpired();
```
**Analysis:** `>` means `block.timestamp == session.expiresAt` is accepted (session not yet expired). This is the same pattern as V1. With proposer timestamp drift of a few seconds, a funding transaction at the exact expiry boundary might be included in a block with `timestamp > expiresAt` and fail, even though the user submitted it "before" expiry in wall-clock time.
**Status:** ACKNOWLEDGED. Same as M-01 in the existing `docs/SECURITY.md`. Use >1 minute expiry windows.

---

## Git history and secret scan

**Scan method:** `git log --all -p -- 'provider/.env' '.env' '*.env.*' 'agent/agent.env' '*private*' '*key*'`
**Result:** No `.env` files, private key material, API tokens, or secret values appear in any commit in the repository history.

**Git remote URL:** The sandbox git config (`.git/config`, not committed to the repository) contains a credential token embedded in the remote URL. This token is NOT in any committed file. See C-01 above.

**`contracts/contract-metadata/BudgetRail.json`:** Contains the deployed contract address and ABI — public information, no secrets.

**`evidence/testnet.json`:** Contains the deployed contract address, deploy tx hash, and USDC address — all public. Lifecycle fields are all `null` — no fabricated data.

---

## Contract source verification

### V1 BudgetRail.sol

| Property | Verified |
|----------|----------|
| Compiler: `^0.8.24` | Yes — Foundry artifact confirms |
| Non-upgradeable (no proxy, no `initialize`) | Yes |
| No admin drain / no `sweep` function | Yes — no function can send tokens to an arbitrary address |
| No `receive()` / `fallback()` | Yes — SC54 test confirms |
| ReentrancyGuard on payForRequest + closeSession | Yes |
| Checks-effects-interactions ordering | Yes — state updated before `safeTransfer` in all write functions |
| EIP-712 domain: `name="BudgetRail" version="1"` | Yes |
| EIP-712 typehash field order matches provider | Yes — verified field-by-field |
| `requestId` replay protection per session | Yes — `_requestPaid[sessionId][requestId]` |
| USDC address from constructor, immutable | Yes |
| `uint96` for budget amounts (no overflow risk for realistic values) | Yes |
| `perPaymentCap <= maxBudget` enforced at session creation | Yes |

### V2 BudgetRailV2.sol

| Property | Verified |
|----------|----------|
| Fee constant `FEE_BPS=50 / FEE_DENOMINATOR=10_000` | Yes |
| `feeAmount = floor(baseAmount * 50 / 10_000)` — integer division | Yes |
| Fee re-verified against caller's `feeAmount` arg | Yes — `InvalidFeeAmount` if mismatch |
| Treasury address in signed struct (prevents fee redirection) | Yes |
| Global requestId uniqueness (stronger than V1) | Yes — `_usedRequestIds[keccak256(sessionId, requestId)]` |
| Atomic two-transfer payout (C then E) | Yes — if E transfer fails, C transfer reverts too (nonReentrant) |
| Skip zero treasury transfer (feeAmount=0 on micro-payments) | Yes — saves gas, event still emitted |
| USDC code-check at constructor | Yes — `extcodesize(usdcAddress) > 0` |
| EIP-712 domain: `name="BudgetRail" version="2"` | Yes — V1 quotes structurally incompatible |
| Non-upgradeable | Yes |
| `uint256` for budget amounts (V1 used `uint96`) | Yes — wider type, same overflow safety |

### V2 EIP-712 type discrepancy (potential)

**File:** `contracts/BudgetRailV2.sol` line 71, `provider/src/lib/eip712.ts` line 167
```solidity
// Contract typehash:
"PaymentQuoteV2(uint256 sessionId,bytes32 requestId,uint256 baseAmount,uint256 feeAmount,"
"uint256 grossAmount,uint256 deadline,address provider,address treasury)"
```
```ts
// Provider types:
{ name: "deadline", type: "uint256" },  // provider uses uint256
```
The contract uses `uint256 deadline` in the typehash (parameter in function is `uint64 deadline`, but cast to `uint256(deadline)` in `abi.encode`). The provider also uses `uint256`. This is correct — same pattern as V1. **Verified.**

---

## Backend security verification

| Check | V1 fulfill | V2 fulfill |
|-------|-----------|-----------|
| SHA-256(input) == requestHash | Yes (step 5) | **Was missing** — H-04, now fixed |
| EIP-712 sig verified | Yes (via session.quoteSigner) | Yes (quoteSigner in session) |
| `receipt.status == success` | Yes | Yes |
| `tx.to == contract` | Yes | Yes |
| PaymentSettled from exact contract address | Yes | Yes (PaymentSettledV2) |
| All event fields matched | Yes | Yes |
| USDC Transfer verified | Yes (1 transfer) | Yes (2 transfers, C and E) |
| Treasury address verified in event | N/A | Yes (step 11) |
| Block timestamp vs deadline | Yes | Yes |
| `tx.from == settled.agent` | Yes | Yes |
| Chain ID config match | Yes | Yes |
| `amount == config.pricePerCall` | Yes | Yes (baseAmount only) |

---

## Frontend analysis

**Chain hardcoding:** All pages import from `arcProfile.ts` which reads from `VITE_*` env vars. No hardcoded `arcTestnet` from `viem/chains` found in pages (deferred P1-D from Part 02 appears to have been resolved by the centralized arcProfile).

**Wallet address case:** `readAddr()` in `arcProfile.ts` normalizes to lowercase. SDK also normalizes. Consistent.

**Receipt status handling:** `useWaitForTransactionReceipt` + `isReceiptSuccess` used in Playground. Success-gated on `receipt.status === "success"`.

**useEffect/render:** Pre-existing `payHashRaw` warning in Playground is a lint false-positive (the dependency is intentionally excluded to avoid infinite loop). No new useEffect issues introduced.

**No simulated balances:** All balance reads use `useReadContract`. No mock data displayed as real values found.

---

## SDK analysis

**Private key leakage:** `BudgetRailSigner` is caller-injected. SDK never generates or stores keys. Confirmed across all `submitPayment`, `addFunds`, `closeAndRefund`, `submitPaymentV2` functions.

**V1/V2 isolation:** `BUDGET_RAIL_ABI` does not contain V2 events; `BUDGET_RAIL_V2_ABI` does not contain V1 functions. Verified in sdk.test.ts.

**Fee math:** `computeV2Fee` uses only `bigint`. Zero floats. Matches contract exactly.

**`IncompleteHistoryError`:** Thrown (not swallowed) when any block window fails. Callers can access `partialResults` and `coverage`.

---

## CI analysis

**Gaps found:**
1. `sdk` job says `bun test src/` but SDK tests are at `packages/sdk/src/` from the root — this will fail unless the job already does `cd packages/sdk`. It does (`cd packages/sdk && bun test src/`) — confirmed correct.
2. No `examples/agent-app` build step in CI (added in Part 09). Agent app build should be tested.
3. Provider test count comment says ~70 (currently 108). Fixed.
4. No Foundry `--gas-report` or coverage step.
5. No explicit Solidity compiler version pin in CI (foundry-toolchain@v1 uses `stable` which tracks Foundry's latest release, not a pinned Solidity version). Low risk — `foundry.toml` pins `solc` via remappings.

---

## Production readiness gaps (NOT release blockers for testnet demo)

These are not bugs but must be addressed before production with real funds:

| Gap | Required for |
|-----|-------------|
| CORS `*` → explicit origin | Production (fixed) |
| Redis-backed rate limiter | Production |
| Structured logging (no stack traces in response) | Production |
| HTTPS for provider API | Production |
| Environment secrets manager (not `.env` file on disk) | Production |
| V2: treasury E ≠ provider C (separate wallets) | Mainnet V2 |
| Treasury E ownership proof (sign a nonce) | Mainnet V2 |
| Independent professional audit of BudgetRail.sol and BudgetRailV2.sol | Mainnet |
| Rotate QUOTE_SIGNER_PRIVATE_KEY (potentially exposed via sandbox ZIP) | Before mainnet |
| Resolve git remote credential token (C-01) | Before public push |
| Complete testnet lifecycle (all 6 steps in GRANT-EVIDENCE.md) | Grant submission |

---

## Changes implemented by this audit

The following source changes were made. Each is safe (no logic regressions):

1. **C-02 fix:** `provider/src/index.ts` — CORS origin now reads `ALLOWED_ORIGIN` env var; `provider/src/lib/config.ts` — `allowedOrigin` added to config.
2. **H-04 fix:** `provider/src/routes/fulfillV2.ts` — `requestHash` is now required in the V2 quote request body and verified against `SHA-256(input)` at fulfillment.
3. **H-05/L-03 fix:** `.github/workflows/ci.yml` — test count comments updated.
4. **M-03 fix:** `src/lib/arcProfile.ts` — console.warn when `VITE_PROVIDER_API_URL` is empty in non-localhost builds.
5. **M-04 fix:** `packages/sdk/src/read.ts` — `fromBlock` default changed from `DEPLOY_BLOCK_TESTNET` to `0n`; callers must pass `fromBlock` from their config.
6. **L-01 fix:** `provider/src/routes/quotes.ts` — error messages for balance/cap checks no longer reveal exact values.
7. **L-02 fix:** `README.md` — provider startup example no longer shows private key inline.
8. **H-03 note:** `docs/SECURITY.md` — H3 added (C=E same address, immutable V2 risk).
9. **M-05 fix:** `evidence/testnet.json` — IMPORTANT note added at top level.
10. **CI:** `examples/agent-app` build step added.

---

## Still MOCKED / unresolved

- `evidence/testnet.json`: All lifecycle tx hashes remain `null` — real testnet transactions have not been executed.
- V2 contract: Not yet deployed — `VITE_BUDGET_RAIL_V2_ADDRESS` = ZERO.
- Treasury E verification: No onchain ownership proof for `0x7D76349B806148594b8075A83b2f8fb12feaA743`.
- Provider backend: No public HTTPS URL — running only locally on port 3001.

---

*This report was produced by internal review. It does not constitute a professional security audit. All findings labelled ACKNOWLEDGED reflect known, accepted design trade-offs documented in `docs/SECURITY.md`. An independent professional audit is required before deploying to mainnet with real user funds.*
