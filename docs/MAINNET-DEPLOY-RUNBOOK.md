# BudgetRail V2 — Mainnet Deploy Runbook

> **WARNING: Arc Studio does not deploy to mainnet, sign mainnet transactions, hold mainnet funds,
> or generate mainnet private keys. Every step in this document must be executed by the operator
> on their own machine with their own wallets and independent tooling.**
>
> Transactions on mainnet involve real funds and are irreversible once submitted.
> Complete every gate below before proceeding to the next section.

---

## 0. Prerequisites — must ALL be true before opening Gate 1

| # | Prerequisite | Status |
|---|-------------|--------|
| 0-A | V1 testnet lifecycle complete (6 steps, real tx hashes in `evidence/testnet.json`) | ☐ PENDING |
| 0-B | V2 testnet lifecycle complete (8 steps, real tx hashes in `evidence/testnet.json → v2Lifecycle`) | ☐ PENDING |
| 0-C | `QUOTE_SIGNER_PRIVATE_KEY` rotated (P0-A — possible sandbox exposure) | ☐ PENDING |
| 0-D | Git remote URL credential token revoked (P0-B) | ☐ PENDING |
| 0-E | Independent security review of `BudgetRail.sol` and `BudgetRailV2.sol` completed | ☐ PENDING |
| 0-F | Treasury E address decided and SEPARATE from provider C address | ☐ PENDING |
| 0-G | All Foundry tests pass: `forge test` → 119/119 | ☐ DONE (verified Part 11) |
| 0-H | Provider tests pass: ~150/150 | ☐ DONE (verified Part 11) |
| 0-I | Frontend lint/typecheck: 0 errors | ☐ DONE (verified Part 11) |
| 0-J | Public HTTPS provider backend deployed and `/api/health` reachable | ☐ PENDING |
| 0-K | Public frontend URL live | ☐ PENDING |

**Do not open Gate 1 until every row above is checked.**

---

## Gate 1 — Chain and Token Verification (dry-run, no broadcast)

### 1.1 Verify Arc Mainnet chain facts

Confirmed from official Arc documentation:

| Fact | Value | Source |
|------|-------|--------|
| Chain ID | `5042` | Arc docs |
| RPC URL | `https://rpc.mainnet.arc.io` | Arc docs |
| Explorer | `https://explorer.arc.io` | Arc docs |
| USDC ERC-20 address | `0x3600000000000000000000000000000000000000` | Arc docs |
| USDC ERC-20 decimals | `6` | Arc docs |
| Native gas decimals | `18` | Arc docs (same pool as ERC-20 USDC — NOT a separate token) |
| Native + ERC-20 | Same pool, two views | Arc docs — never double-count |

**Verify USDC onchain before deploy:**
```bash
# Confirm symbol and decimals — run from your own machine
cast call 0x3600000000000000000000000000000000000000 \
  "symbol()(string)" \
  --rpc-url https://rpc.mainnet.arc.io

cast call 0x3600000000000000000000000000000000000000 \
  "decimals()(uint8)" \
  --rpc-url https://rpc.mainnet.arc.io
# Expected: "USDC", 6
```

### 1.2 Verify deployer wallet has Arc Mainnet USDC for gas

```bash
cast balance <DEPLOYER_ADDRESS> \
  --rpc-url https://rpc.mainnet.arc.io \
  --ether
# Arc native gas IS USDC (18-decimal view). Minimum: ~0.01 USDC native (18-dec).
```

---

## Gate 2 — Address Ownership Proofs (no private keys shared)

Before deploying, record the following in `evidence/mainnet.json`:

### 2.1 Treasury E ownership proof

Treasury E is **immutable** in `BudgetRailV2.sol`. Once deployed it cannot be changed.

```bash
# On your own machine — sign a canonical nonce to prove ownership.
# NEVER share the private key; only share the signature and public address.
cast wallet sign --private-key <TREASURY_E_KEY> \
  "I am the owner of BudgetRail treasury address E for mainnet deployment $(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Record: address, nonce string, signature in evidence/mainnet.json → ownershipProofs.treasuryE
```

### 2.2 Provider C ownership proof

Provider C is per-session (not a constructor arg), but must be proven before the first mainnet session.

```bash
cast wallet sign --private-key <PROVIDER_C_KEY> \
  "I am the owner of BudgetRail provider address C for mainnet deployment $(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Record: address, nonce string, signature in evidence/mainnet.json → ownershipProofs.providerC
```

### 2.3 Verify C ≠ E

```bash
# Must print two DIFFERENT addresses
echo "Provider C: $PROVIDER_C_ADDRESS"
echo "Treasury E: $TREASURY_E_ADDRESS"
# If equal: STOP. Deploy with separate E address. See SECURITY.md H3.
```

---

## Gate 3 — V2 Compile and Dry-Run (no broadcast)

### 3.1 Build V2 contract

```bash
cd /path/to/BudgetRail   # your local checkout — NOT Arc Studio
forge build
# Verify: contracts/out/BudgetRailV2.sol/BudgetRailV2.json exists
```

### 3.2 Record source hash

```bash
sha256sum contracts/BudgetRailV2.sol
# Record in evidence/mainnet.json → v2Contract.sourceHash
```

### 3.3 Exact constructor arguments

```
Arg 0 — usdcAddress:   0x3600000000000000000000000000000000000000
Arg 1 — treasury:      <TREASURY_E_ADDRESS>   ← your verified E address
Arg 2 — providerHint:  <PROVIDER_C_ADDRESS>   ← emits TreasuryMatchesProviderWarning if C=E
```

### 3.4 Run preflight check (dry-run)

```bash
# From your local checkout
VITE_BUDGET_RAIL_V2_ADDRESS=0x0000000000000000000000000000000000000000 \
VITE_TREASURY_ADDRESS=<TREASURY_E_ADDRESS> \
VITE_PROVIDER_PAYOUT=<PROVIDER_C_ADDRESS> \
VITE_QUOTE_SIGNER=<QUOTE_SIGNER_D_ADDRESS> \
VITE_ARC_NETWORK=mainnet \
bun run v2:preflight --network mainnet
# Expected: all checks green, no C=E block (since C≠E)
```

### 3.5 Dry-run deploy (no --broadcast)

```bash
forge script contracts/script/DeployCreate2.s.sol \
  --rpc-url https://rpc.mainnet.arc.io \
  --chain-id 5042 \
  --sig "run(address,address,address)" \
    0x3600000000000000000000000000000000000000 \
    <TREASURY_E_ADDRESS> \
    <PROVIDER_C_ADDRESS> \
  -vvvv
# DO NOT add --broadcast yet.
# Record: estimated gas, predicted address (if Create2), constructor args hash.
```

### 3.6 Expected post-deploy onchain state

After deploy, verify these are correct **before** creating any session:

```bash
V2=<DEPLOYED_V2_ADDRESS>
RPC=https://rpc.mainnet.arc.io

cast call $V2 "FEE_BPS()(uint256)"       --rpc-url $RPC   # must be 50
cast call $V2 "FEE_DENOMINATOR()(uint256)" --rpc-url $RPC # must be 10000
cast call $V2 "VERSION()(string)"         --rpc-url $RPC  # must be "2"
cast call $V2 "USDC_ADDRESS()(address)"   --rpc-url $RPC  # must be 0x3600...
cast call $V2 "TREASURY()(address)"       --rpc-url $RPC  # must be <TREASURY_E_ADDRESS>
cast call $V2 "computeFee(uint256)(uint256,uint256)" 50000 --rpc-url $RPC
# must return: fee=250, gross=50250
```

---

## Gate 4 — Mainnet Deployment (OPERATOR BROADCAST — outside Arc Studio)

> **STOP HERE.** Run every gate above first. Broadcast only with explicit operator approval.
>
> Arc Studio does not and cannot perform this step.

```bash
# Add --broadcast only after all gates above pass.
forge script contracts/script/DeployCreate2.s.sol \
  --rpc-url https://rpc.mainnet.arc.io \
  --chain-id 5042 \
  --private-key <DEPLOYER_PRIVATE_KEY> \
  --sig "run(address,address,address)" \
    0x3600000000000000000000000000000000000000 \
    <TREASURY_E_ADDRESS> \
    <PROVIDER_C_ADDRESS> \
  --broadcast \
  -vvvv
```

### After deploy — record immediately

Fill these into `evidence/mainnet.json → v2Contract`:

```
contractAddress:  <address from deploy output>
deployTxHash:     <tx hash from deploy output>
deployBlock:      <block number from explorer>
explorerUrl:      https://explorer.arc.io/address/<address>
explorerTxUrl:    https://explorer.arc.io/tx/<tx hash>
sourceHash:       <sha256sum output from Gate 3.2>
constructorArgs:
  usdcAddress:    0x3600000000000000000000000000000000000000
  treasury:       <TREASURY_E_ADDRESS>
  providerHint:   <PROVIDER_C_ADDRESS>
feeBps_verified:  50   (cast call FEE_BPS)
version_verified: "2"  (cast call VERSION)
```

---

## Gate 5 — Config Updates (after deploy, before first mainnet session)

Update all three config locations atomically:

### 5.1 Frontend `.env` (mainnet vars)

```bash
# Add to .env (NEVER commit this file):
VITE_BUDGET_RAIL_V2_MAINNET_ADDRESS=<deployed V2 address>
VITE_TREASURY_MAINNET_ADDRESS=<TREASURY_E_ADDRESS>
VITE_MAINNET_PROVIDER_PAYOUT=<PROVIDER_C_ADDRESS>
VITE_MAINNET_QUOTE_SIGNER=<QUOTE_SIGNER_D_ADDRESS>
VITE_MAINNET_PROVIDER_API_URL=https://<your-provider-domain>
VITE_ARC_NETWORK=mainnet
```

### 5.2 `src/lib/arcProfile.ts` — update mainnet deploy block

```typescript
// After deploy, replace 0n with the actual block:
v2DeployBlock: <DEPLOY_BLOCK>n,   // mainnet profile only
```

### 5.3 Provider `provider/.env` (mainnet vars — never commit)

```bash
PROVIDER_NETWORK=mainnet
BUDGET_RAIL_V2_ADDRESS=<deployed V2 address>
TREASURY_ADDRESS=<TREASURY_E_ADDRESS>
PROVIDER_PAYOUT_ADDRESS=<PROVIDER_C_ADDRESS>
QUOTE_SIGNER_PRIVATE_KEY=<new rotated key — from secure secret manager>
ALLOWED_ORIGIN=https://arc-budgetrail.vercel.app
```

### 5.4 Fail-closed verification

After updating config, restart the frontend build and confirm:

```bash
bun run build
# Open built app — if V2 address is still zero it shows "V2 not deployed" banner.
# After correct address: VersionBanner shows mainnet + V2 + contract address.
```

---

## Gate 6 — Mainnet Lifecycle (tiny amounts, operator approval required for each tx)

> Each transaction below requires explicit operator go-ahead.
> Target amounts are minimal — $0.10 budget, one $0.05 payment.

### Step 6.1 — Create V2 session (owner wallet A)

```bash
cast send <V2_ADDRESS> \
  "createSession(address,address,address,uint256,uint256,uint64)" \
  <AGENT_B_ADDRESS> \
  <PROVIDER_C_ADDRESS> \
  <QUOTE_SIGNER_D_ADDRESS> \
  100250 \
  50250 \
  $(($(date +%s) + 86400)) \
  --rpc-url https://rpc.mainnet.arc.io \
  --private-key <OWNER_A_KEY>
# maxBudget=100250 ($0.100250 gross), perPaymentCap=50250 ($0.050250 gross), 24h expiry
# Record: tx hash, sessionId from SessionCreated event
```

### Step 6.2 — Approve and fund (owner wallet A)

```bash
# Approve
cast send 0x3600000000000000000000000000000000000000 \
  "approve(address,uint256)" <V2_ADDRESS> 100250 \
  --rpc-url https://rpc.mainnet.arc.io \
  --private-key <OWNER_A_KEY>

# Fund
cast send <V2_ADDRESS> \
  "fundSession(uint256,uint256)" <SESSION_ID> 100250 \
  --rpc-url https://rpc.mainnet.arc.io \
  --private-key <OWNER_A_KEY>
# Record: tx hashes, confirm totalFunded=100250
```

### Step 6.3 — Request quote from provider

```bash
curl -X POST https://<PROVIDER_URL>/api/quotes/v2 \
  -H "Content-Type: application/json" \
  -d '{"sessionId":<SESSION_ID>,"agentAddress":"<AGENT_B_ADDRESS>","inputText":"Hello BudgetRail mainnet"}'
# Verify response:
#   baseAmount:  50000  ($0.050000)
#   feeAmount:   250    ($0.000250)
#   grossAmount: 50250  ($0.050250)
#   provider:    <PROVIDER_C_ADDRESS>
#   treasury:    <TREASURY_E_ADDRESS>
#   feeBps:      50
```

### Step 6.4 — Pay (agent wallet B)

The V2 function signature is (added in Part 04 — requestHash binds the quote to the exact input):
```
payForRequestV2(uint256 sessionId, uint256 baseAmount, uint256 feeAmount,
                bytes32 requestId, bytes32 requestHash, uint64 deadline, bytes sig)
```

```bash
# requestHash = SHA-256 of the exact UTF-8 bytes of the input document
# Obtain requestHash from the /api/quotes/v2 response body field "requestHash"
cast send <V2_ADDRESS> \
  "payForRequestV2(uint256,uint256,uint256,bytes32,bytes32,uint64,bytes)" \
  <SESSION_ID> 50000 250 <REQUEST_ID> <REQUEST_HASH> <DEADLINE> <SIGNATURE> \
  --rpc-url https://rpc.mainnet.arc.io \
  --private-key <AGENT_B_KEY>
# Pass criteria:
#   PaymentSettledV2 event: requestHash=<REQUEST_HASH>, baseAmount=50000, feeAmount=250, grossAmount=50250
#   Transfer log 1: from contract, to <PROVIDER_C_ADDRESS>, value=50000
#   Transfer log 2: from contract, to <TREASURY_E_ADDRESS>, value=250
#   session.totalSpent increases by exactly 50250
```

IMPORTANT: Never omit `requestHash`. A quote signed without `requestHash` in the EIP-712 struct
is invalid — the contract's ECDSA recovery will fail and the transaction will revert.

### Step 6.5 — Fulfill

```bash
curl -X POST https://<PROVIDER_URL>/api/fulfill/v2 \
  -H "Content-Type: application/json" \
  -d '{"txHash":"<PAY_TX_HASH>","requestId":"<REQUEST_ID>","inputText":"Hello BudgetRail mainnet"}'
# Verify: real result returned, not delivered before payment confirmed
```

### Step 6.6 — Close session (owner wallet A)

```bash
cast send <V2_ADDRESS> \
  "closeSession(uint256)" <SESSION_ID> \
  --rpc-url https://rpc.mainnet.arc.io \
  --private-key <OWNER_A_KEY>
# Expected refund: 100250 − 50250 = 50000 units ($0.05)
# Verify: SessionClosed event, owner receives 50000 USDC, treasury E NOT reversed
```

---

## Gate 7 — Evidence Recording

After all steps above, fill `evidence/mainnet.json` completely:

- All tx hashes (real, from explorer)
- All explorer URLs
- Ownership proof signatures for C and E
- Source hash of deployed contracts
- Screenshot or recording URL showing the full flow

---

## NO-GO conditions — stop immediately if any of these occur

| Condition | Action |
|-----------|--------|
| `FEE_BPS` onchain ≠ 50 | Do not create sessions. Redeploy with correct contract. |
| `TREASURY` onchain ≠ configured E address | Do not create sessions. Redeploy. |
| `USDC_ADDRESS` onchain ≠ `0x3600...` | Do not use. Wrong USDC. |
| Chain ID in wallet ≠ 5042 | Switch wallet to Arc Mainnet. |
| `computeFee(50000)` returns fee≠250 or gross≠50250 | Do not create sessions. Bug in deployed contract. |
| Provider C or Treasury E address unverified | Prove ownership before funding any session. |
| Independent security review not completed | Do not proceed to mainnet. |
| Open CRITICAL or HIGH findings from Part 10 audit not resolved | Do not proceed. |

---

## Fee transparency — must be visible before every mainnet payment

Every payment must show all three amounts before signing:

| Amount | Value (example) | Unit |
|--------|----------------|------|
| Provider base (→ C) | 50,000 | USDC units = $0.050000 |
| Platform fee 0.5% (→ E) | 250 | USDC units = $0.000250 |
| **Gross total deducted** | **50,250** | USDC units = $0.050250 |
| Gas (separate) | ~0.000001 USDC | 18-decimal native view |

This breakdown appears in: frontend FeeBreakdown component, quote API response, EIP-712 signed payload fields (`baseAmount`, `feeAmount`, `grossAmount`), PaymentSettledV2 event, SDK `V2FeePrice` object, and README.

---

## Summary: what is NOT done yet (exact missing evidence)

1. V1 testnet lifecycle — `evidence/testnet.json → testnetLifecycle` all null
2. V2 testnet lifecycle — `evidence/testnet.json → v2Lifecycle` all null
3. V2 contract not deployed to testnet or mainnet
4. Treasury E ownership proof — not recorded
5. Provider C ownership proof — not recorded
6. C=E decision not made
7. Independent security review — not performed
8. Public HTTPS provider URL — does not exist
9. Public frontend URL — does not exist
10. Mainnet contract address — does not exist
