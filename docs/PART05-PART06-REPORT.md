# Part 05 + Part 06 — Security Review Report

**Date:** 2026-10-25
**Status:** COMPLETE — all items investigated, fixed where needed, tested.

---

## Part 05 — V2 Additive 0.5% Service Fee, Treasury and Wallet Roles

### 1. Fee Math Audit (Contract + Provider + SDK + UI)

#### BudgetRailV2.sol — VERIFIED CORRECT, NO CHANGES NEEDED

| Property | Finding |
|----------|---------|
| `FEE_BPS = 50`, `FEE_DENOMINATOR = 10_000` | `public constant` — immutable, part of bytecode |
| `payForRequestV2` fee computation | `expectedFee = (baseAmount * 50) / 10_000` — Solidity integer division = floor, exact |
| Caller-supplied `feeAmount` verification | `if (feeAmount != expectedFee) revert InvalidFeeAmount()` — contract is the source of truth, not the backend |
| `grossAmount = baseAmount + feeAmount` | Computed in-contract, not caller-supplied; used for all cap/budget checks |
| `totalSpent` debit | Debited by `grossAmount`, not `baseAmount` |
| Provider C transfer | `safeTransfer(provider_, baseAmount)` — C always receives exactly base |
| Treasury E transfer | `safeTransfer(TREASURY, feeAmount)` — skipped (not a zero-transfer) when `feeAmount == 0` |
| Atomicity | Both transfers inside `nonReentrant`; if either `safeTransfer` reverts, entire tx reverts, state unchanged |
| Create/fund/close/refund | No fee — only `payForRequestV2` incurs fee |
| Zero-amount path | `if (baseAmount == 0) revert ZeroAmount()` — never reaches fee computation |
| Overflow | Uses `uint256`; `baseAmount * 50` can overflow only above `2^256/50 ≈ 2.3×10^74` — unreachable with USDC 6-decimal amounts |

**Micro-payment boundary (explicitly documented):**

| Base | Fee = floor(base×50/10000) | Gross | Treasury Transfer |
|------|---------------------------|-------|-------------------|
| 199 | 0 | 199 | none |
| 200 | 1 | 201 | 1 unit |
| 201 | 1 | 202 | 1 unit |

Fee zero at base < 200 (< $0.000200). This is intentional, documented in contract natspec and in this report.

#### provider/src/lib/eip712.ts — VERIFIED CORRECT

`computeV2Fee(baseAmount: bigint)` uses `(baseAmount * 50n) / 10_000n` — pure bigint, identical to Solidity floor division. No floating point.

#### provider/src/routes/quotesV2.ts — VERIFIED CORRECT

- Calls `computeV2Fee(config.v2PricePerCall)` server-side; caller cannot supply their own fee.
- `treasury` in signed quote taken from `config.treasuryAddress` (server config, not user input).
- `grossAmount` returned explicitly in quote for UI display.

#### provider/src/routes/fulfillV2.ts — VERIFIED CORRECT

- Re-computes `computeV2Fee(baseAmount)` and verifies `feeAmount` and `grossAmount` match.
- Verifies two separate USDC `Transfer` logs (vault→C and vault→E) are present in the receipt.
- When `feeAmount == 0`, no treasury transfer is expected (matches contract behavior).

#### packages/sdk/src/ — VERIFIED CORRECT

- `computeV2Fee(baseUnits: bigint)` in `types.ts`: `(baseUnits * 50n) / 10_000n` — bigint.
- `verifyQuoteV2` re-computes fee and verifies both `feeAmount` and `grossAmount` against expected.
- `simulatePayV2`/`submitPaymentV2` pass `quote.baseAmount`, `quote.feeAmount` in correct order.
- Post-receipt verification: `settledEvent.feeAmount !== expected.feeUnits` check in `submitPaymentV2`.

#### src/pages/Playground.tsx — VERIFIED CORRECT (one display fix applied)

- Fee breakdown displayed in quote panel when `version === "2"`.
- **Fixed (display only):** Confirm modal previously showed "USDC charge" without labeling it as gross for V2. Now shows three lines: "Provider base (C)", "Platform fee 0.5% (E)", "Gross charge (base + fee)".
- All BigInt conversions correct; no floating point in USDC arithmetic paths.

### 2. Transfer Atomicity

Proven correct by:
- ATOM-01 (Foundry): blocklisted C → tx reverts, C gets nothing, state unchanged, requestId not consumed, retry succeeds.
- ATOM-02 (Foundry): blocklisted E → tx reverts, C also gets nothing (both transfers are in the same tx).
- ATOM-04 (Foundry): reentrancy guard blocks double-spend even via a malicious ERC-20.
- ATOM-05 (Foundry): no treasury charge on create/fund/close.

### 3. C == E Guard

**Finding:** The contract allows C == E at deploy time (emits `TreasuryMatchesProviderWarning` but does not revert). This is intentional for testnet. The problem is an operator may copy the provider payout address as treasury when deploying to mainnet, making fee revenue indistinguishable.

**Fix applied (`provider/src/lib/config.ts`):**

```typescript
// Hard-fail at startup on mainnet when TREASURY_ADDRESS === PROVIDER_PAYOUT_ADDRESS
if (network === "mainnet" && treasuryAddress && treasuryAddress === providerPayoutAddress) {
  throw new Error("[MAINNET C==E GUARD] ...");
}
```

This catches the most common misconfig: an operator who copies their payout address into `TREASURY_ADDRESS` for mainnet. Testnet is unaffected (C == E is valid on testnet, e.g. sessions #20 and #21).

**Scope:** This is a config-layer guard, not an onchain guard. The contract's immutable `TREASURY` is set at deploy time. The server check prevents the provider from serving V2 requests when C == E on mainnet, which is the strongest runtime protection available short of redeploying.

**Not in scope:** A UI-level `createSession` guard was not added. Sessions are created by owners, not the provider server. An owner may create any C/E combination they choose — the contract allows it. A UI warning is appropriate but not a hard block (some operators may intentionally use C == E on testnet). The operator's responsibility is to deploy with distinct C and E on mainnet.

### 4. Unusual Role Overlaps

| Overlap | Contract behavior | Tested |
|---------|------------------|--------|
| A == B (owner == agent) | Allowed; owner can pay directly. Used in manual demo mode. | AUTH-03 |
| A == C (owner == provider) | Allowed; owner receives both refund and provider payment. No contract restriction. | Not explicitly required |
| B == C (agent == provider) | Allowed; agent pays and receives. No contract restriction. | Not explicitly required |
| D == A/B/C | Allowed; D is only used for signature verification, receives no revenue. | Not a concern |
| Deployer | Has no privileged withdrawal. No `owner` or `admin` role in V2. | Confirmed by source read |

None of these overlaps bypass onchain rules. The contract only checks `msg.sender == session.agent` for payments and `msg.sender == session.owner` for fund/close.

### 5. New Tests Added

**`provider/test/feeArithmetic.test.ts`** — 15 tests:
- Standard cases ($0.05, $1.00, $100)
- Boundary: base=199 (fee=0), base=200 (fee=1), base=201 (fee=1)
- Rounding: 333_333 → floor(1666.665) = 1666
- Large values: 10^15 base units
- Invariant: `grossAmount == baseAmount + feeAmount` for all sample values
- Type check: return values are bigint (not number)
- Additive model: C receives full base (fee not deducted)

**Existing Foundry tests (already passing, not modified):**
- FEE-01 through FEE-09, FUZZ-01 through FUZZ-04, ATOM-01 through ATOM-08

---

## Part 06 — Production API Routes, RPC 503 Handling, and Provider Signer Safety

### 1. Vercel Routing Audit

**vercel.json (fixed in Part 04, confirmed correct now):**

```json
{ "source": "/api/quotes/v2",  "destination": "/api/quotes/v2" },
{ "source": "/api/fulfill/v2", "destination": "/api/fulfill/v2" }
```

The V2 serverless functions live at `api/quotes/v2.ts` and `api/fulfill/v2.ts`. The old rewrites pointed at the non-existent `api/quotesV2.ts`/`api/fulfillV2.ts` — fixed in Part 04.

**`functions` key in vercel.json:** Only covers `api/*.ts` (flat). The nested files `api/quotes/v2.ts` and `api/fulfill/v2.ts` are automatically recognized by Vercel's file-system routing without needing an explicit entry — Vercel treats any `.ts` under `api/` as a function. No change needed.

**`api/quotes/v2.ts` and `api/fulfill/v2.ts`:** Both delegate to `handleQuotesV2`/`handleFulfillV2`. Correct.

**SPA catch-all:** `"source": "/(.*)", "destination": "/index.html"` is LAST in the list. `/api/*` routes are matched first, so the SPA never swallows API calls. Correct.

### 2. api/rpc.ts — Method Blocklist and Retry

**Findings:**

- **P06-A (MEDIUM):** The proxy had no method-level filtering. `eth_sendRawTransaction` could be relayed through the server without knowing the upstream RPC credentials.
- **P06-B (LOW):** No retry logic on 429/503 upstream responses.

**Fixes applied:**

```typescript
// Block write methods
const BLOCKED_METHODS = new Set([
  "eth_sendRawTransaction",
  "eth_sendTransaction",
]);
// Returns 403 when blocked method detected in body (handles single and batch requests)
```

```typescript
// One retry on 429 (rate-limited) or 503 (temporarily unavailable)
async function fetchWithRetry(url, body) {
  const res = await fetchWithTimeout(url, body);
  if (res.status === 429 || res.status === 503) {
    await new Promise(r => setTimeout(r, 600));
    return fetchWithTimeout(url, body);
  }
  return res;
}
```

**Unchanged:** 504 on timeout (gateway timeout is the semantically correct status; 503 is for "service unavailable"). CORS origin allowlist (tracked file — not changed per project rules).

**Note:** The proxy is a Vercel serverless function and is not equivalent to full API auth. CORS is not authentication. The method blocklist prevents the most obvious misuse (broadcasting transactions), but the proxy should not be considered a hardened API gateway. For production, the operator should consider adding an API secret or limiting the proxy to specific IP ranges.

### 3. loadConfig() — Private Key Validation

**Finding (P06-C, MEDIUM):** If `QUOTE_SIGNER_PRIVATE_KEY` is set to an invalid value (wrong length, missing 0x prefix, non-hex), the provider would crash mid-request inside `signQuoteV2` with an unhelpful viem error, not at startup.

**Fix applied:**
```typescript
if (!/^0x[0-9a-fA-F]{64}$/.test(quoteSignerPrivateKey)) {
  throw new Error("QUOTE_SIGNER_PRIVATE_KEY is not a valid 0x-prefixed 32-byte hex string...");
}
```

This runs once at config load (every cold start or request on Vercel), providing an immediate diagnostic.

### 4. Health Endpoint

**Verified:** `GET /api/health` returns sanitized JSON — no private key, no internal env values. Only public fields: chainId, contractAddress, providerPayout, quoteSignerAddress, network, v2 info. If RPC is unreachable, returns 503 with `status: "degraded"` but still returns payout/signer addresses so the operator can verify config.

**If QUOTE_SIGNER_PRIVATE_KEY is missing/invalid:** `loadConfig()` throws (now with clearer message) → Vercel serverless `api/health.ts` catches it → returns HTTP 500 `{ "error": "..." }`. This is acceptable (the misconfigured server should not serve 200 OK).

### 5. Signer/Address Mismatch Detection

Already implemented in `quotesV2.ts` and `quotes.ts`:
- `session.provider.toLowerCase() !== config.providerPayoutAddress.toLowerCase()` → 400 "Session provider does not match"
- `session.quoteSigner.toLowerCase() !== expectedSigner.toLowerCase()` → 400 "Session quoteSigner does not match"

These are the runtime guards for old signer sessions. If the key is rotated, new quotes cannot be issued for sessions created with the old signer — this is by design and is fail-closed.

**Note on compromised old keys:** If `QUOTE_SIGNER_PRIVATE_KEY` is rotated (operator action P0-A), sessions with the old signer address in `session.quoteSigner` will permanently return 400 "quoteSigner mismatch." The operator must close those sessions and create new ones. There is no re-enable path — this is the correct secure behavior.

### 6. New Tests Added

**`provider/test/httpSmoke.test.ts`** — 22 tests:
- Health: returns JSON, does not leak private key, v2Enabled=false when not configured
- V1 /api/quotes: invalid inputs return 400, RPC failure returns non-200, Content-Type correct
- V2 /api/quotes/v2: disabled returns 503, invalid inputs return 400, V2 route reachable
- V1/V2 segregation: V1 works when V2 disabled, V2 is independent
- Config validation: private key regex tests, C==E mainnet guard logic

---

## Summary of All Changes

| File | Change |
|------|--------|
| `provider/src/lib/config.ts` | Private key format validation at startup; C==E mainnet hard-fail guard |
| `api/rpc.ts` | `BLOCKED_METHODS` set (eth_sendRawTransaction, eth_sendTransaction); `fetchWithRetry` with 600ms backoff on 429/503 |
| `src/pages/Playground.tsx` | Confirm modal: V2 quotes now show base/fee/gross breakdown instead of single "USDC charge" |
| `provider/test/feeArithmetic.test.ts` | 15 new fee-arithmetic unit tests |
| `provider/test/httpSmoke.test.ts` | 22 new HTTP smoke tests |

---

## Test Results

| Suite | Result |
|-------|--------|
| Foundry V1 | 62/62 pass |
| Foundry V2 | 57/57 pass |
| bun test (all) | 470/471 pass — 1 pre-existing localhost:3001 integration fail |
| Lint (oxlint) | 0 errors, 0 warnings |
| Typecheck (tsc) | 0 errors |

---

## Root Causes (Proven vs Suspected)

| ID | Finding | Root Cause | Severity | Status |
|----|---------|-----------|---------|--------|
| P05-UI | Confirm modal labeled V2 gross as "USDC charge" | No version branch in modal body | Low (display) | Fixed |
| P05-CEE | No mainnet C==E guard in provider | Policy check missing from `loadConfig()` | Medium (operator risk) | Fixed |
| P06-A | RPC proxy allowed `eth_sendRawTransaction` | No method blocklist | Medium (misuse vector) | Fixed |
| P06-B | No upstream retry on 429/503 | Missing retry logic | Low | Fixed |
| P06-C | Invalid private key crashes mid-request | No startup validation | Medium (availability) | Fixed |

---

## Remaining Risks

1. **CORS origin list in `api/rpc.ts`** is hardcoded in source and includes the sandbox preview hostname (which changes per session). An operator redeploying should update this list. Not fixed here (tracked file constraint; operator action required after redeploy).
2. **C == E testnet sessions (#20, #21)** are intentional and cannot be changed without closing and recreating them. The mainnet guard only activates on `network === "mainnet"`.
3. **`QUOTE_SIGNER_PRIVATE_KEY` rotation (P0-A)** is still a pending operator action. Sessions created with the current signer will stop working after rotation. Close those sessions first.
4. **Vercel env vars (M-02)** still need to be added to the Vercel dashboard before the deployed app can sign V2 quotes.
5. **V2 not yet deployed (H-01)** — `VITE_BUDGET_RAIL_V2_ADDRESS` is still empty. V2 routes return 503 on production until the contract is deployed and the address is configured.

---

**STOP — awaiting operator approval before Part 07.**
