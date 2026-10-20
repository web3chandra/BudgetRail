# BudgetRail — Deployment Guide

> **All mainnet steps require your independent review and explicit operator authorization.**
> Arc Studio does not deploy to mainnet, sign mainnet transactions, or move real funds.
> Never paste private keys into this document or any chat interface.

---

## Testnet deployment (already done)

| Field | Value |
|-------|-------|
| Network | Arc Testnet |
| Chain ID | 5042002 |
| Contract | `0xf6a13df15ad93c2e2968e1d69c53894a923bda21` |
| Deploy tx | `0xf33cb9096a45c5cc083fbee4366384f4257f509ab94fe46ec4291e775bc4a5d9` |
| Explorer | https://explorer.testnet.arc.io/address/0xf6a13df15ad93c2e2968e1d69c53894a923bda21 |
| Constructor arg | `0x3600000000000000000000000000000000000000` (Arc USDC ERC-20) |

---

## Mainnet operator runbook

### Prerequisites

- [ ] Arc Foundry installed: https://book.getfoundry.sh/getting-started/installation  
      (Windows users: use WSL2 — `wsl --install`, then install Foundry inside WSL2)
- [ ] Bun installed: https://bun.sh
- [ ] A deployer wallet (role A) with Arc Mainnet USDC for gas
- [ ] A quote signer private key (role D) — store in a secrets manager (not a .env file on disk)
- [ ] A provider payout wallet address (role C) — this is where USDC payments arrive
- [ ] All 138 automated tests passing (see TEST-REPORT.md)
- [ ] Independent contract review complete

### Step 0: Verify Arc Mainnet chain facts

These values come from `src/onchain-facts.ts` — do NOT type them from memory.

```
Chain ID:      5042
RPC:           https://rpc.mainnet.arc.io
USDC ERC-20:   0x3600000000000000000000000000000000000000
Decimals:      6 (ERC-20 view); 18 (native gas view — same pool)
Explorer:      https://explorer.arc.io
```

Verify the USDC address is live:
```bash
cast call 0x3600000000000000000000000000000000000000 \
  "decimals()(uint8)" \
  --rpc-url https://rpc.mainnet.arc.io
# Expected: 6
```

### Step 1: Pre-flight checks

```bash
# 1. Clean install
bun install
cd provider && bun install && cd ..
cd agent && bun install && cd ..

# 2. All contract tests green
forge test
# Expected: 59 passed, 0 failed

# 3. All provider tests green
cd provider && bun test
# Expected: 64 passed, 0 failed

# 4. All agent tests green
cd agent && bun test src/test/
# Expected: 15 passed, 0 failed

# 5. Frontend clean
bun run check
# Expected: 0 errors

# 6. Fresh contract build
forge build
# Artifact: contracts/out/BudgetRail.sol/BudgetRail.json
```

### Step 2: Review the deployment script and constructor

The contract constructor takes a single argument: the USDC ERC-20 address.

```solidity
constructor(address usdcAddress) EIP712("BudgetRail", "1") {
    if (usdcAddress == address(0)) revert ZeroAddress();
    USDC_TOKEN = IERC20(usdcAddress);
    USDC_ADDRESS = usdcAddress;
}
```

The correct mainnet constructor argument is:
```
0x3600000000000000000000000000000000000000
```

Verify this matches the value in `src/onchain-facts.ts` before proceeding.

### Step 3: Deploy to Arc Mainnet

> **Warning:** Do not run this command until you have completed Steps 0–2, received an independent contract review, and explicitly decided to proceed with a mainnet deployment.

Using `forge create` (recommended for non-upgradeable contracts):

```bash
forge create contracts/BudgetRail.sol:BudgetRail \
  --rpc-url https://rpc.mainnet.arc.io \
  --private-key $DEPLOYER_PRIVATE_KEY \
  --constructor-args 0x3600000000000000000000000000000000000000 \
  --verify \
  --etherscan-api-key $ARCSCAN_API_KEY
```

> Arc uses its own block explorer. Adjust `--verify` flags as needed if Arc's explorer requires different parameters.

Record the deployed address and transaction hash immediately.

### Step 4: Verify deployed contract

```bash
# Check USDC_ADDRESS is set correctly
cast call <DEPLOYED_ADDRESS> \
  "USDC_ADDRESS()(address)" \
  --rpc-url https://rpc.mainnet.arc.io
# Expected: 0x3600000000000000000000000000000000000000

# Check EIP-712 domain separator (optional — use a test call)
```

### Step 5: Configure provider server

Set these environment variables on your production server. **Never commit these to git.**

```bash
export PROVIDER_NETWORK=mainnet
export ARC_MAINNET_RPC_URL=https://rpc.mainnet.arc.io
export BUDGET_RAIL_MAINNET_ADDRESS=<deployed address>
export PROVIDER_PAYOUT_ADDRESS=<wallet C address>
export QUOTE_SIGNER_PRIVATE_KEY=<key D — from secrets manager>
export PRICE_PER_CALL_BASE_UNITS=50000
export QUOTE_WINDOW_SECONDS=600
export MAX_INPUT_BYTES=8192
export RATE_LIMIT_PER_MINUTE=10
export PORT=3001
```

Start the server:
```bash
bun run provider/src/index.ts
```

Verify health:
```bash
curl https://your-api-host/api/health
```

### Step 6: Configure frontend

Set these in `.env` (public values only; no private keys):

```env
VITE_BUDGET_RAIL_ADDRESS=<mainnet deployed address>
VITE_PROVIDER_API_URL=https://your-api-host
VITE_PROVIDER_PAYOUT=<wallet C address>
VITE_QUOTE_SIGNER=<quote signer PUBLIC address — safe to expose>
```

Build and deploy the frontend:
```bash
bun run build
# Output: dist/
```

### Step 7: Mainnet lifecycle test

Perform these steps manually, recording all transaction hashes in `evidence/mainnet.json`.

1. Owner A creates a session with a small budget ($1 max, $0.05 per-payment cap):
   ```
   createSession(agentB, providerC, signerD, 1000000, 50000, expiresAt)
   ```
   Record: sessionId, txHash.

2. Owner A approves exact USDC amount and funds the session:
   ```
   USDC.approve(BudgetRail, 1000000)
   fundSession(sessionId, 1000000)
   ```
   Record: approve txHash, fund txHash.

3. Agent B requests a quote from the provider API and pays:
   ```
   POST /api/quotes
   payForRequest(sessionId, requestId, requestHash, 50000, deadline, sig)
   ```
   Record: payment txHash.

4. POST /api/fulfill with the receipt — verify DocumentInsights result is returned.
   Record: fulfill response, block number.

5. Verify on-chain:
   - `PaymentSettled` event present in the tx
   - ERC-20 `Transfer` from BudgetRail to providerC for 50000 units
   - `getSession(sessionId).totalSpent == 50000`

6. Owner A closes the session:
   ```
   closeSession(sessionId)
   ```
   Record: close txHash, refund amount (should be ~950000 units).

7. Verify accounting:
   - Net USDC cost to owner A: 1 × $0.05 = $0.05 (plus gas)
   - Provider C balance increased by 50000 units
   - Explorer links: https://explorer.arc.io/tx/<hash>

8. Record all values in `evidence/mainnet.json` — no fabricated data.

---

## CI (automated, no funded transactions)

See `.github/workflows/ci.yml`. CI runs all tests without requiring keys or mainnet funds.
