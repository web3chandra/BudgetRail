# BudgetRail — Test Report

All test results in this file are from actual test runs in the Arc Studio sandbox.
No results are fabricated or projected.

---

## 1. Smart contract tests (Foundry)

**Command:** `forge test --match-path contracts/test/BudgetRail.t.sol -v`
**Compiler:** solc 0.8.28, EVM Paris, optimizer 200 runs
**Framework:** Foundry (forge-std)

### Results

| Suite | Tests | Pass | Fail | Time |
|-------|-------|------|------|------|
| BudgetRailTest (functional + adversarial) | 57 | 57 | 0 | 105.71ms |
| BudgetRailInvariant | 2 | 2 | 0 | 25.47s |
| **Total** | **59** | **59** | **0** | |

Invariant configuration:
- 256 sequences × 500 calls = **128,000 calls** each invariant
- 0 reverts in either invariant

### Test coverage by category

| Category | Tests | Description |
|----------|-------|-------------|
| Immutability | SC01 | USDC_TOKEN and USDC_ADDRESS immutable |
| Session IDs | SC02 | Start at 1, monotonically increment |
| Isolation | SC03, SC15 | Sessions isolated by owner and session ID |
| Decimal | SC04, SC20 | 6-decimal USDC boundary; distinct from native 18-dec |
| Funding | SC05, SC06 | Bounded allowance, multi-deposit, max overflow |
| EIP-712 payment | SC07, SC08 | Valid quote transfers exact amount |
| Per-payment cap | SC09 | Exact cap passes, one-over fails |
| Exhaustion | SC10, SC11 | Last payment drains; underfunded reverts |
| Close/refund | SC12, SC13, SC14 | Partial, full, post-expiry close |
| Event ABI | SC16 | All four events decode correctly from logs |
| Pagination | SC17 | `sessionIdsByOwner` slice/offset correctness |
| Zero params | SC21–SC28 | Zero addresses, zero budget, zero cap, past expiry |
| Access control | SC29–SC31 | Non-owner fund/close, non-agent pay |
| Sig attacks | SC32–SC39 | Wrong signer, wrong chain, wrong contract, mutated fields |
| Replay | SC40, SC41 | Duplicate requestId; same ID in different sessions OK |
| Expiry | SC42, SC43 | Expired quote; expired session |
| Post-close | SC44 | Spend after close reverts |
| Overfunding | SC45 | Over maxBudget reverts |
| Large amounts | SC46 | uint96 overflow handled |
| Reentrancy | SC47 | ReentrantToken + revert-bubble confirms nonReentrant works |
| Double close | SC48 | Second closeSession reverts |
| Rollback | SC49, SC50 | Failed transfer and failed refund both roll back state |
| Fixed provider | SC51 | Payment always goes to session.provider |
| Constructor | SC52 | Zero USDC address reverts |
| Missing allowance | SC53 | Fund without approve reverts |
| No receive | SC54 | Plain ETH send reverts |
| Blocklist | SC55 | Blocklisted provider blocks payment mid-session |
| viem vector | SC56 | EIP-712 domain/typehash matches viem implementation |
| Unicode | SC57 | Unicode requestHash handled identically |
| Invariant | — | totalFunded ≤ maxBudget; totalSpent ≤ totalFunded |
| Fuzz | SC18, SC19 | Amount and budget fuzz (512 runs each) |

---

## 2. Provider API tests (Bun)

**Command:** `cd provider && bun test`
**Runtime:** Bun 1.3.14

| File | Tests | Pass | Fail |
|------|-------|------|------|
| test/eip712.test.ts | 11 | 11 | 0 |
| test/insights.test.ts | 13 | 13 | 0 |
| test/quotes.test.ts | 19 | 19 | 0 |
| test/fulfill.test.ts | 21 | 21 | 0 |
| **Total** | **64** | **64** | **0** |

### Quotes tests (Q01–Q19)
Input validation (Q02–Q05), session checks from chain (Q06–Q12), price enforcement (Q13), requestHash/requestId generation (Q14–Q15), secret non-leakage (Q16), error cases (Q17–Q18), unicode (Q19).

### Fulfill tests (F01–F21)
Valid request (F01), tx not found (F02), reverted tx (F03), wrong contract (F04), no log (F05), fake contract with same topic (F06), wrong agent (F07), altered input (F08), wrong chainId/contract/provider/amount (F09–F12), no Transfer log (F13), Transfer mismatch (F14), deadline exceeded (F15), late-fulfillment of timely payment (F16), idempotency (F17), invalid txHash (F18), missing fields (F19), secret non-leakage (F20), RPC timeout (F21).

---

## 3. Agent CLI tests (Bun)

**Command:** `cd agent && bun test src/test/`

| File | Tests | Pass | Fail |
|------|-------|------|------|
| src/test/agent.test.ts | 15 | 15 | 0 |
| **Total** | **15** | **15** | **0** |

Tests: A01–A12 (quote verification), C01–C03 (config loading).

---

## 4. Frontend checks

**Command:** `bun run check` (lint + typecheck)

| Check | Errors | Warnings |
|-------|--------|----------|
| oxlint (type-aware) | 0 | 0 |
| TypeScript (tsc --noEmit) | 0 | — |
| **Total** | **0** | **0** |

---

## 5. Testnet lifecycle

Automated contract testing runs against a Foundry local EVM (no live RPC required).
Live testnet lifecycle (create session, fund, pay, close) requires user-controlled wallets.

See `evidence/testnet.json` for the status of the manual lifecycle run.
Manual steps are documented in `docs/arc-studio-provenance.md`.

---

## Summary

| Suite | Tests | Pass | Fail | Status |
|-------|-------|------|------|--------|
| Contract (Foundry) | 59 | 59 | 0 | GREEN |
| Provider API (Bun) | 64 | 64 | 0 | GREEN |
| Agent CLI (Bun) | 15 | 15 | 0 | GREEN |
| Frontend lint+TS | — | — | 0 | GREEN |
| **Total automated** | **138** | **138** | **0** | **ALL GREEN** |
