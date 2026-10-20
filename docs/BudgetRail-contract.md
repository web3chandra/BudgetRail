# BudgetRail Smart Contract — Technical Reference

**File:** `contracts/BudgetRail.sol`  
**Artifact:** `contracts/out/BudgetRail.sol/BudgetRail.json`  
**Solidity:** `^0.8.24` (compiled with 0.8.28, EVM Paris)  
**Network:** Arc Testnet (chainId 5042002) / Arc Mainnet (chainId 5042)  
**USDC ERC-20:** `0x3600000000000000000000000000000000000000` (6 decimals)  
**Status:** Compiled clean — Part 2 of 11, not yet deployed

---

## Overview

BudgetRail is a non-upgradeable, non-custodial USDC payment-session vault for programmable agent-to-provider payments. An Owner creates a bounded session naming exactly one authorized Agent, one Provider payout wallet, and one quote Signer. The Agent pays invoices through the contract; the Provider verifies real onchain settlement before returning a result.

No admin functions. No sweep functions. No arbitrary-destination payments. No delegatecall. No upgradeability.

---

## Roles

| Role | Symbol | Responsibility |
|------|--------|---------------|
| Owner | A | Creates session, funds budget, closes and reclaims unspent USDC |
| Agent | B | Only wallet authorized to call `payForRequest` for this session |
| Provider payout | C | Receives USDC on every successful `payForRequest`; set at session creation, never changeable |
| Quote signer | D | Holds the private key that signs EIP-712 `PaymentQuote` structs; verified onchain via ECDSA recover; never the same key as the payout wallet |

---

## Session Lifecycle

```
createSession()  →  fundSession()  →  payForRequest() (0..N)  →  closeSession()
     ↑ Owner A         ↑ Owner A          ↑ Agent B                  ↑ Owner A
```

1. `createSession` — Owner A creates the session, setting all parameters immutably.
2. `fundSession` — Owner A approves USDC and deposits. Multiple deposits allowed up to `maxBudget`. Only callable while the session is open and unexpired.
3. `payForRequest` — Agent B submits a quote (signed by D) and the contract transfers USDC to Provider C.
4. `closeSession` — Owner A closes the session and receives `totalFunded - totalSpent` back. Callable even after expiry.

---

## Accounting Invariant

```
At all times per session:
  totalSpent ≤ totalFunded ≤ maxBudget

On closeSession:
  refund = totalFunded - totalSpent  (always ≥ 0)
```

### Example ($1.00 funded, two $0.05 payments, $0.90 refundable)

| Step | Action | totalFunded (raw) | totalSpent (raw) | Contract balance |
|------|--------|-------------------|-----------------|-----------------|
| fundSession | deposit 1_000_000 | 1_000_000 | 0 | 1_000_000 |
| payForRequest | pay 50_000 | 1_000_000 | 50_000 | 950_000 |
| payForRequest | pay 50_000 | 1_000_000 | 100_000 | 900_000 |
| closeSession | refund 900_000 | 1_000_000 | 100_000 | 0 |

All amounts are USDC ERC-20 units (6 decimals). 1 USDC = 1,000,000 raw units.
Gas fees on Arc are paid in native USDC (18-decimal gas view — separate accounting from ERC-20 session funds).

---

## EIP-712 Domain

```
name:              "BudgetRail"
version:           "1"
chainId:           block.chainid  (runtime — 5042002 testnet / 5042 mainnet)
verifyingContract: <deployed address>
```

### PaymentQuote Type

```
PaymentQuote(
  uint256 sessionId,
  bytes32 requestId,
  bytes32 requestHash,
  uint256 amount,
  uint64  quoteDeadline
)
```

`amount` is `uint256` in the type string and ABI-encoded as such (cast from `uint96` before hashing). `requestHash = keccak256(requestBody)` — binds the invoice to the exact content the agent submitted.

The quote signer computes:

```ts
const digest = hashTypedData({
  domain: { name: "BudgetRail", version: "1", chainId, verifyingContract },
  types: {
    PaymentQuote: [
      { name: "sessionId",    type: "uint256" },
      { name: "requestId",    type: "bytes32" },
      { name: "requestHash",  type: "bytes32" },
      { name: "amount",       type: "uint256" },
      { name: "quoteDeadline",type: "uint64"  },
    ],
  },
  primaryType: "PaymentQuote",
  message: { sessionId, requestId, requestHash, amount: BigInt(amount), quoteDeadline },
});
```

---

## Function Reference

### `constructor(address usdcAddress)`
Deploys the contract. `usdcAddress` must be non-zero. On Arc Testnet: `0x3600000000000000000000000000000000000000`.

### `createSession(agent, provider, quoteSigner, maxBudget, perPaymentCap, expiresAt) → sessionId`
Creates a new session. Session IDs start at 1 and increment monotonically.

| Validation | Error |
|-----------|-------|
| Any address is zero | `ZeroAddress` |
| `maxBudget == 0` | `InvalidBudget` |
| `perPaymentCap == 0` or `perPaymentCap > maxBudget` | `InvalidPerPaymentCap` |
| `expiresAt ≤ block.timestamp` | `ExpiryInPast` |

### `fundSession(sessionId, amount)`
Deposits USDC into the session. Caller must have prior `approve(BudgetRail, amount)` on USDC.

| Validation | Error |
|-----------|-------|
| Session doesn't exist | `SessionNotFound` |
| Caller is not owner | `NotOwner` |
| Session is closed | `SessionAlreadyClosed` |
| Session is expired | `SessionExpired` |
| `amount == 0` | `ZeroAmount` |
| `totalFunded + amount > maxBudget` | `BudgetExceeded` |

State is updated before `safeTransferFrom` (CEI pattern).

### `payForRequest(sessionId, requestId, requestHash, amount, quoteDeadline, providerSignature)`
Pays the provider for a specific request. Only callable by the session agent.

| Validation | Error |
|-----------|-------|
| Session doesn't exist | `SessionNotFound` |
| Caller is not agent | `NotAgent` |
| Session is closed | `SessionAlreadyClosed` |
| Session is expired | `SessionExpired` |
| `amount == 0` | `ZeroAmount` |
| `amount > perPaymentCap` | `PerPaymentCapExceeded` |
| `totalSpent + amount > totalFunded` | `FundedBudgetExceeded` |
| `totalSpent + amount > maxBudget` | `LifetimeBudgetExceeded` |
| `block.timestamp > quoteDeadline` | `QuoteExpired` |
| `quoteDeadline > expiresAt` | `QuoteDeadlineExceedsSession` |
| `requestId` already paid | `RequestAlreadyPaid` |
| Recovered signer ≠ `quoteSigner` | `InvalidSignature` |

Payment recipient is **always `session.provider`** — no user-supplied destination argument.  
`nonReentrant`. State (replay marker + totalSpent) updated before `safeTransfer` (CEI).

### `closeSession(sessionId)`
Permanently closes session. Refunds `totalFunded - totalSpent` to owner. Callable even after expiry.

| Validation | Error |
|-----------|-------|
| Session doesn't exist | `SessionNotFound` |
| Caller is not owner | `NotOwner` |
| Session already closed | `SessionAlreadyClosed` |

`nonReentrant`. `closed = true` set before refund transfer (CEI).

### `getSession(sessionId) → Session`
Returns the full session struct. Returns zero-value struct for non-existent session (check `owner != address(0)`).

### `availableBalance(sessionId) → uint96`
Returns `totalFunded - totalSpent`. Returns 0 for non-existent or closed sessions.

### `sessionIdsByOwner(owner, offset, limit) → uint256[]`
Paginated session IDs for an owner. Returns empty array (no revert) when `offset ≥ count`.

### `ownerSessionCount(owner) → uint256`
Total number of sessions created by an owner.

---

## Events

### `SessionCreated(sessionId, owner, agent, provider, quoteSigner, maxBudget, perPaymentCap, expiresAt)`
Emitted by `createSession`. `sessionId`, `owner`, `agent` are indexed.

### `SessionFunded(sessionId, owner, amount, totalFunded)`
Emitted by `fundSession`. `sessionId`, `owner` indexed.

### `PaymentSettled(sessionId, requestId, provider, requestHash, agent, amount, quoteDeadline)`
Emitted by `payForRequest`. `sessionId`, `requestId`, `provider` indexed. `requestHash` is unindexed for full-value access in the Provider API's receipt verification.

### `SessionClosed(sessionId, owner, refunded, totalSpent)`
Emitted by `closeSession`. `sessionId`, `owner` indexed.

---

## Custom Errors

| Error | Trigger |
|-------|---------|
| `ZeroAddress` | Any address argument is `address(0)` |
| `InvalidBudget` | `maxBudget == 0` |
| `InvalidPerPaymentCap` | cap is zero or exceeds maxBudget |
| `ExpiryInPast` | `expiresAt ≤ block.timestamp` at creation |
| `SessionNotFound` | sessionId maps to zero-owner |
| `NotOwner` | Caller is not `session.owner` |
| `NotAgent` | Caller is not `session.agent` |
| `SessionAlreadyClosed` | `session.closed == true` |
| `SessionExpired` | `block.timestamp > session.expiresAt` |
| `ZeroAmount` | `amount == 0` |
| `BudgetExceeded` | deposit would exceed `maxBudget` |
| `FundedBudgetExceeded` | payment would exceed `totalFunded` |
| `LifetimeBudgetExceeded` | payment would exceed `maxBudget` |
| `PerPaymentCapExceeded` | single payment exceeds `perPaymentCap` |
| `QuoteExpired` | `block.timestamp > quoteDeadline` |
| `QuoteDeadlineExceedsSession` | `quoteDeadline > session.expiresAt` |
| `RequestAlreadyPaid` | `requestId` already settled in this session |
| `InvalidSignature` | recovered signer ≠ `session.quoteSigner` |
| `InvalidOffset` | declared but reserved for future pagination use |
| `ECDSAInvalidSignature` | OZ ECDSA: signature encodes to address(0) |
| `ECDSAInvalidSignatureLength` | OZ ECDSA: wrong byte length |
| `ECDSAInvalidSignatureS` | OZ ECDSA: S value out of range |
| `SafeERC20FailedOperation` | OZ SafeERC20: token transfer failed |
| `ReentrancyGuardReentrantCall` | OZ ReentrancyGuard: nested call |

---

## Security Notes

### 1. Unsolicited / forced token deposits
USDC transferred directly to the contract address (not via `fundSession`) is **not credited to any session** and **cannot be recovered**. There is no sweep or recovery function. Tokens sent this way are permanently locked. Always use `fundSession`.

### 2. USDC blocklist reversions
Circle's USDC contract maintains a blocklist. If the provider (C) is blocklisted after session creation, `payForRequest` will revert permanently for that session. If the owner (A) is blocklisted, `closeSession` will revert permanently. There is no fallback recipient or admin override in this MVP — this is a known, stated limitation.

### 3. Reentrancy
`payForRequest` and `closeSession` carry the `nonReentrant` modifier. All state mutations (`_requestPaid`, `totalSpent`, `closed`) occur before external `safeTransfer` calls (checks-effects-interactions). `fundSession` also updates `totalFunded` before calling `safeTransferFrom`.

### 4. Block-timestamp expiry
Session and quote expiry checks use `block.timestamp`. Arc validators have standard EVM ~15-second timestamp discretion. Use session durations well above 15 seconds (practical minimum: several minutes; recommended: hours to days) to avoid boundary-case expiry grief. The Forge lint warnings about `block.timestamp` are informational and expected for any time-bounded contract.

### 5. EIP-712 domain binding
The domain separator encodes `chainId` at runtime via `block.chainid` and `verifyingContract = address(this)`. A quote signed for Arc Testnet (5042002) is rejected on Arc Mainnet (5042), and vice versa. A quote signed for a different BudgetRail deployment is rejected. This is correct behavior.

### 6. uint96 amount range
`uint96` holds up to 79,228,162,514,264,337,593,543,950,335 raw units ≈ 79 trillion USDC. No realistic budget will overflow. The `newTotalFunded = session.totalFunded + amount` addition uses checked arithmetic (Solidity 0.8+ default) so an overflow reverts rather than wrapping.

---

## ABI (from compiled artifact)

The full ABI is available at:  
`contracts/out/BudgetRail.sol/BudgetRail.json` (Foundry artifact)

Import in TypeScript:
```ts
import budgetRailArtifact from '../contracts/out/BudgetRail.sol/BudgetRail.json';
const abi = budgetRailArtifact.abi;
```

Or use the ABI inline with viem:
```ts
import { parseAbi } from 'viem';
// use the full JSON ABI from the artifact for production
```

---

## OpenZeppelin Dependencies (pinned 5.1.0)

| Import | Justification |
|--------|--------------|
| `ReentrancyGuard` | Protects `payForRequest` and `closeSession` from re-entrant calls |
| `SafeERC20` | Safe `transferFrom` and `transfer` — handles non-reverting ERC-20s and provides unified error |
| `EIP712` | Provides domain separator + `_hashTypedDataV4` — eliminates hand-rolled hashing bugs |
| `ECDSA` | Signature recovery — handles malleability guard (S-value check) and zero-address check |

`SignatureChecker` is **not used** — all verification is against a stored EOA address (`session.quoteSigner`), so `ECDSA.recover` is sufficient. Contract signers are out of scope for MVP.

Files avoided due to Cancun `mcopy` opcode incompatibility with Paris EVM target: `Strings.sol`, `Math.sol`, `Bytes.sol`, and any contract importing them.
