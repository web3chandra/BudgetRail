# BudgetRailV2 — Testnet Verification Plan

**Status:** PENDING OPERATOR EXECUTION  
**Chain:** Arc Testnet (chainId 5042002)  
**USDC ERC-20:** `0x3600000000000000000000000000000000000000` (6 decimals)  
**Explorer:** https://explorer.testnet.arc.io  
**Script:** `bun run scripts/v2-testnet-demo.ts`

---

## Operator Config Checklist (complete before Step 1)

All values below must be confirmed by the operator and set in `.env` before any step is executed.
Never share private keys — only public addresses are listed here.

| Variable | Role | Required | Source |
|----------|------|----------|--------|
| `VITE_BUDGET_RAIL_V2_ADDRESS` | V2 contract | After deploy | Deploy tx receipt |
| `VITE_TREASURY_ADDRESS` | E — platform fee recipient | Before deploy | Operator-controlled wallet |
| `VITE_PROVIDER_PAYOUT` | C — provider revenue | Before deploy | Provider-controlled wallet |
| `VITE_QUOTE_SIGNER` | D — EIP-712 signer public key | Before deploy | Derived from `QUOTE_SIGNER_PRIVATE_KEY` |
| `OPERATOR_WALLET_A` | A — session owner | Step 1 | Operator test wallet |
| `OPERATOR_WALLET_B` | B — authorized agent | Step 1 | Separate test wallet |

**C=E policy:** Both C and E are currently `0x7D76349B806148594b8075A83b2f8fb12feaA743`.
This is valid for testnet. Separate before mainnet (`bun run v2:preflight --network mainnet` will block if C=E).

---

## USDC Address Verification

Before deploying V2, verify the USDC address independently:

```bash
# Confirm Arc Testnet USDC ERC-20
cast call 0x3600000000000000000000000000000000000000 \
  "decimals()" --rpc-url https://rpc.testnet.arc.io
# Expected: 6

cast call 0x3600000000000000000000000000000000000000 \
  "symbol()" --rpc-url https://rpc.testnet.arc.io
# Expected: USDC
```

Source: [Arc docs — USDC on Arc](https://docs.arc.io) and `src/onchain-facts.ts`.

---

## V2 Constructor

```
BudgetRailV2(
  address usdcAddress,    // 0x3600000000000000000000000000000000000000
  address treasury,       // VITE_TREASURY_ADDRESS (role E) — immutable
  address providerHint    // VITE_PROVIDER_PAYOUT (role C) — hint only, emits warning if C==E
)
```

**FEE_BPS = 50** (0.5%, immutable, encoded in bytecode)  
**Non-upgradeable:** no proxy, no owner drain, no admin sweep.

---

## Step 0 — Preflight (dry-run, no broadcast)

```bash
# Run all config checks without touching the chain
bun run scripts/v2-testnet-demo.ts --step preflight
```

**Pass criteria:**
- [ ] RPC responds with a current block number
- [ ] USDC decimals onchain == 6
- [ ] USDC symbol onchain == "USDC"
- [ ] `VITE_BUDGET_RAIL_V2_ADDRESS` is set and non-zero (or deploy instructions shown)
- [ ] `VITE_TREASURY_ADDRESS` matches `TREASURY()` onchain
- [ ] `FEE_BPS()` onchain == 50
- [ ] `VERSION()` onchain == "2"
- [ ] `computeFee(50000)` onchain returns fee=250, gross=50250
- [ ] Fee math table shows $0.05 → $0.00025 fee → $0.05025 gross

---

## Step 1 — Create V2 Session (operator approval required before broadcast)

```bash
# Dry-run: shows exact parameters without sending
bun run scripts/v2-testnet-demo.ts --step 1

# Broadcast (after operator confirms parameters above):
bun run scripts/v2-testnet-demo.ts --step 1 --broadcast
# Then run the cast command printed by the script
```

**Session parameters:**
| Field | Value | Notes |
|-------|-------|-------|
| `agent` | wallet B | Authorized to call payForRequestV2 |
| `provider` | wallet C | Receives base USDC per payment |
| `quoteSigner` | wallet D | Signs EIP-712 quotes |
| `maxBudget` | 500,250 units ($0.500250) | Gross cap: 10 payments of $0.05025 |
| `perPaymentCap` | 50,250 units ($0.050250) | One $0.05 payment gross |
| `expiresAt` | now + 86400s | 24 hours |

**Pass criteria:**
- [ ] Transaction confirmed on Arc Testnet
- [ ] `SessionCreated` event emitted with correct addresses
- [ ] `sessionId` returned and recorded in `evidence/testnet.json`
- [ ] Explorer shows tx success
- [ ] `getSession(sessionId).owner == walletA`
- [ ] `getSession(sessionId).totalFunded == 0` (not yet funded)

**Record in evidence/testnet.json:**
```json
"createSessionTxHash": "0x...",
"createSessionBlock": <block>,
"sessionId": <id>
```

---

## Step 2 — Approve and Fund Session

```bash
bun run scripts/v2-testnet-demo.ts --step 2
# Then run the two cast commands printed (approve, then fundSession)
```

**Deposit amount:** 500,250 USDC units ($0.500250)

**Pass criteria:**
- [ ] `approve()` tx confirmed; allowance == 500,250
- [ ] `fundSession()` tx confirmed
- [ ] `SessionFunded` event emitted; amount == 500,250
- [ ] `availableBalance(sessionId)` == 500,250
- [ ] `balanceOf(contract)` increased by 500,250
- [ ] Owner A USDC balance decreased by 500,250

**Record in evidence/testnet.json:**
```json
"approveUsdcTxHash": "0x...",
"fundSessionTxHash": "0x...",
"fundSessionBlock": <block>
```

---

## Step 3 — Request and Verify V2 Quote

```bash
bun run scripts/v2-testnet-demo.ts --step 3
# Then run the curl command printed against the running provider
```

**Expected quote fields:**

| Field | Expected Value |
|-------|---------------|
| `baseAmount` | 50,000 |
| `feeAmount` | 250 (= floor(50000 × 50 / 10000)) |
| `grossAmount` | 50,250 |
| `provider` | matches `VITE_PROVIDER_PAYOUT` |
| `treasury` | matches `VITE_TREASURY_ADDRESS` AND `TREASURY()` onchain |
| `signer` | matches `VITE_QUOTE_SIGNER` |

**Verification checklist:**
- [ ] `feeAmount` == floor(baseAmount × 50 / 10000) — exact integer math
- [ ] `grossAmount` == baseAmount + feeAmount
- [ ] provider == C address (not zero, not treasury)
- [ ] treasury == E address, matches onchain immutable
- [ ] EIP-712 domain: `name="BudgetRail"`, `version="2"`, `chainId=5042002`, `verifyingContract=<V2>`
- [ ] ECDSA recovery of signature == D address
- [ ] deadline > now, <= session.expiresAt
- [ ] requestId is a fresh value (not previously used)
- [ ] No private key material in quote response

---

## Step 4 — Pay and Verify Dual USDC Transfers

```bash
bun run scripts/v2-testnet-demo.ts --step 4
# Agent B sends payForRequestV2 using the signed quote from Step 3
```

**Pass criteria — MUST ALL PASS:**
- [ ] Transaction confirmed (no revert)
- [ ] Exactly **1** `PaymentSettledV2` event in receipt
- [ ] `PaymentSettledV2.baseAmount` == 50,000
- [ ] `PaymentSettledV2.feeAmount` == 250
- [ ] `PaymentSettledV2.grossAmount` == 50,250
- [ ] `PaymentSettledV2.provider` == C address
- [ ] `PaymentSettledV2.treasury` == E address
- [ ] Exactly **2** ERC-20 `Transfer` events in same tx
- [ ] `Transfer[0]`: from=contract, to=C, value=50,000
- [ ] `Transfer[1]`: from=contract, to=E, value=250
- [ ] `availableBalance(sessionId)` decreased by exactly 50,250
- [ ] `balanceOf(C)` increased by exactly 50,000
- [ ] `balanceOf(E)` increased by exactly 250
- [ ] `getSession(sessionId).totalSpent` == 50,250
- [ ] No additional transfers (no double payout)

**Record in evidence/testnet.json:**
```json
"payment1TxHash": "0x...",
"payment1Block": <block>,
"payment1BaseAmount": 50000,
"payment1FeeAmount": 250,
"payment1GrossAmount": 50250,
"payment1ProviderDelta": 50000,
"payment1TreasuryDelta": 250,
"payment1Event": "PaymentSettledV2",
"payment1TransferCount": 2
```

---

## Step 5 — Provider Fulfillment

```bash
bun run scripts/v2-testnet-demo.ts --step 5
# Then run the curl command against http://localhost:3001/api/fulfill/v2
```

**Pass criteria:**
- [ ] Provider locates `PaymentSettledV2` event from txHash
- [ ] Provider verifies C == `PROVIDER_PAYOUT_ADDRESS`
- [ ] Provider verifies E == `TREASURY_ADDRESS`
- [ ] Provider verifies baseAmount == 50,000
- [ ] Provider verifies feeAmount == 250
- [ ] Provider verifies `requestHash == SHA-256(inputText)`
- [ ] Provider returns non-empty result
- [ ] Re-calling fulfill with same txHash returns identical result (idempotent)
- [ ] Re-calling does NOT trigger a second payment or any onchain write
- [ ] History scan (`/api/health` or frontend PaymentHistory) shows the PaymentSettledV2 event
- [ ] History shows correct base/fee/gross breakdown

**Record in evidence/testnet.json:**
```json
"fulfillRequestId": "<request-id>",
"fulfillResultNonEmpty": true,
"retryFulfillIdempotent": true
```

---

## Step 6 — Close Session and Verify Refund

```bash
bun run scripts/v2-testnet-demo.ts --step 6
```

**Expected amounts after one $0.05 payment and close:**

| | Amount | USDC |
|--|--------|------|
| totalFunded | 500,250 | $0.500250 |
| totalSpent | 50,250 | $0.050250 |
| expectedRefund | 450,000 | $0.450000 |
| Treasury E delta on close | 0 | Fee is NOT reversed |

**Pass criteria:**
- [ ] `closeSession()` confirmed
- [ ] `SessionClosed` event: `refundAmount` == 450,000
- [ ] Owner A USDC balance increased by exactly 450,000
- [ ] C balance unchanged after close
- [ ] E balance unchanged after close (fee is final, not reversed)
- [ ] `availableBalance(sessionId)` == 0
- [ ] `getSession(sessionId).closed` == true
- [ ] Second `closeSession()` reverts with `SessionAlreadyClosed`

**Record in evidence/testnet.json:**
```json
"closeSessionTxHash": "0x...",
"closeSessionBlock": <block>,
"closeRefundAmount": 450000,
"closeTreasuryDelta": 0,
"closeProviderDelta": 0
```

---

## Step 7 — Offline Rejection Tests (no live gas)

These run entirely in the Foundry test suite. No testnet transactions needed.

```bash
forge test --match-path contracts/test/BudgetRailV2.t.sol -v
# Expected: 60/60 pass
```

| Test Case | Action | Expected |
|-----------|--------|----------|
| Wrong agent | Call from non-agent wallet | `NotAgent` revert |
| Over gross cap | grossAmount > perPaymentCap | `PerPaymentCapExceeded` revert |
| Invalid signer | Signature from wrong key | `InvalidSignature` revert |
| Expired quote | deadline < block.timestamp | `QuoteExpired` revert |
| Expired session | block.timestamp > expiresAt | `SessionExpired` revert |
| Replay requestId | Same requestId, second call | `RequestAlreadyUsed` revert |
| Network mismatch | Wrong chainId in EIP-712 domain | `InvalidSignature` revert |
| Inflated fee | feeAmount > floor(base*50/10000) | `InvalidFeeAmount` revert |
| Deflated fee | feeAmount < floor(base*50/10000) | `InvalidFeeAmount` revert |
| Tampered treasury | Wrong treasury in signed data | `TreasuryMismatch` / `InvalidSignature` |
| V1 domain | version="1" in EIP-712 domain | `InvalidSignature` revert |
| Double close | closeSession twice | `SessionAlreadyClosed` revert |
| Over budget | totalSpent + gross > totalFunded | `FundedBudgetExceeded` revert |

All these are covered in `contracts/test/BudgetRailV2.t.sol`. **Current: 60/60 pass.**

---

## Step 8 — Evidence Record

After completing Steps 1–6, update `evidence/testnet.json` with all tx hashes, block numbers, event data, and balance deltas.

Run the template generator:
```bash
bun run scripts/v2-testnet-demo.ts --step 8
```

**Security checklist for evidence file:**
- [ ] No private keys, mnemonics, or sensitive input in evidence file
- [ ] All tx hashes verified on https://explorer.testnet.arc.io
- [ ] C and E balances delta verified independently (not from provider claim)
- [ ] `computeFee` result verified onchain AND via SDK `computeV2Fee()`
- [ ] EIP-712 signer verified via `ecrecover` / `cast wallet verify`
- [ ] V1 contract and sessions unaffected by V2 deployment

---

## What to do when V2 is NOT yet deployed

If `VITE_BUDGET_RAIL_V2_ADDRESS` is zero or unset:

1. Run the preflight to confirm config:
   ```bash
   bun run v2:preflight --network testnet
   ```

2. Build the contract:
   ```bash
   forge build
   ```

3. Dry-run the deploy script (no broadcast):
   ```bash
   bun run deploy:self BudgetRailV2 \
     '["0x3600000000000000000000000000000000000000","<TREASURY_E>","<PROVIDER_C>"]' \
     --chain ARC-TESTNET
   # Review the fee estimate and wallet address printed
   ```

4. Request operator approval, then broadcast:
   > **STOP** — broadcast requires explicit approval. Share the dry-run output for review first.

5. After deploy: set `VITE_BUDGET_RAIL_V2_ADDRESS` in `.env` and update `v2DeployBlock` in `src/lib/arcProfile.ts`.

---

## Role Ownership Evidence

Before any testnet transaction, the operator must confirm:

| Role | Address | Ownership Proof Method |
|------|---------|----------------------|
| A — owner | `OPERATOR_WALLET_A` | Signs a nonce: `cast wallet sign --from <A>` |
| B — agent | `OPERATOR_WALLET_B` | Same as above |
| C — provider | `VITE_PROVIDER_PAYOUT` | Message signature or statement from provider |
| D — signer | `VITE_QUOTE_SIGNER` | Derive from `QUOTE_SIGNER_PRIVATE_KEY` via `cast wallet address` |
| E — treasury | `VITE_TREASURY_ADDRESS` | Operator confirms control before V2 deploy |

Use `src/components/OwnershipProof.tsx` in the UI for C and D sign-a-nonce verification.

---

## V1 Isolation Guarantee

V2 deployment does NOT affect V1:
- V1 contract at `0xf6a13df15ad93c2e2968e1d69c53894a923bda21` is immutable and independent.
- V1 sessions continue to function regardless of V2 state.
- V1 uses EIP-712 domain `name="BudgetRail"`, `version="1"` — structurally incompatible with V2.
- Frontend shows V1 and V2 sessions in separate tabs.
- SDK uses separate ABIs (`BUDGET_RAIL_ABI` vs `BUDGET_RAIL_V2_ABI`) and separate event parsers.

---

## Stop Conditions

**Stop and do not proceed** if any of the following are true:

- `TREASURY()` onchain != `VITE_TREASURY_ADDRESS` in `.env`
- `FEE_BPS()` onchain != 50
- `computeFee(50000)` returns fee != 250 or gross != 50250
- Any `Transfer` event is missing or has wrong value in Step 4
- More than 2 `Transfer` events in the payment tx
- `PaymentSettledV2.treasury` != `VITE_TREASURY_ADDRESS`
- Fulfill returns result without verifying C/E transfers
- Evidence file contains null fields that should be populated

In any of these cases, halt, record the failure in `evidence/testnet.json`, and seek independent review.
