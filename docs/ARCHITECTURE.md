# BudgetRail — Architecture

## Overview

BudgetRail is a full-stack, non-custodial USDC payment system for software agents. It consists of four components that interact through well-defined, verifiable interfaces.

```
┌──────────────────────────────────────────────────────────────────┐
│                        Arc Blockchain                            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  BudgetRail.sol (non-upgradeable EVM contract)           │   │
│  │  - USDC_TOKEN / USDC_ADDRESS (immutable)                 │   │
│  │  - Session storage: owner A, agent B, provider C, D      │   │
│  │  - createSession / fundSession / payForRequest           │   │
│  │  - closeSession (refund to owner)                        │   │
│  │  - Replay guard: _requestPaid[sessionId][requestId]      │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌────────────────┐           ┌─────────────────────────────┐   │
│  │  USDC ERC-20   │           │  EIP-712 signed quote       │   │
│  │  0x3600...0000 │           │  domain: BudgetRail/1/      │   │
│  │  6 decimals    │           │  chainId/verifyingContract  │   │
│  └────────────────┘           └─────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
         ▲                                      ▲
         │ payForRequest(sig)                   │ RPC reads
         │                                      │
┌────────┴─────────┐              ┌─────────────┴──────────────┐
│  Agent B (CLI)   │              │  Provider API (Bun/TS)     │
│  agent/src/      │ ─── POST ──► │  provider/src/             │
│  - reads session │ /api/quotes  │  GET  /api/health          │
│  - verifies sig  │ ─── POST ──► │  POST /api/quotes          │
│  - calls         │ /api/fulfill │  POST /api/fulfill         │
│   payForRequest  │              │  - verifies receipt proof  │
└──────────────────┘              │  - returns DocumentInsights│
                                  └────────────────────────────┘
                                           ▲
                                           │ Web UI
                               ┌───────────┴──────────┐
                               │  Frontend (React/Vite) │
                               │  src/pages/           │
                               │  - Dashboard          │
                               │  - CreateBudget       │
                               │  - Playground         │
                               │  - PaymentHistory     │
                               │  - ManageSession      │
                               └───────────────────────┘
```

## Roles

| Role | Label | Key Location | Trust |
|------|-------|-------------|-------|
| Owner | A | User's browser wallet | Creates/funds/closes sessions |
| Agent | B | Local keyfile (`agent/`) | Sends `payForRequest` txns |
| Provider payout | C | Receives USDC; address-only in contract | Passive recipient |
| Quote signer | D | Provider server env (`QUOTE_SIGNER_PRIVATE_KEY`) | Signs EIP-712 quotes |

Key D never appears on-chain directly (only its public address is stored in `session.quoteSigner`). It is separate from provider wallet C so a key-compromise of D cannot redirect funds to a different address (C is immutable per session).

## Contract storage layout

```
mapping(uint256 => Session)                _sessions
mapping(uint256 => mapping(bytes32 => bool)) _requestPaid
mapping(address => uint256[])              _ownerSessions
uint256                                    _nextSessionId
IERC20 immutable                           USDC_TOKEN
address immutable                          USDC_ADDRESS
```

All amounts use `uint96` (max ~79 trillion USDC base units). Session IDs start at 1.

## EIP-712 domain and type

```
domain:
  name:              "BudgetRail"
  version:           "1"
  chainId:           <runtime chainId>
  verifyingContract: <deployed contract address>

type PaymentQuote:
  uint256 sessionId
  bytes32 requestId
  bytes32 requestHash
  uint256 amount
  uint64  quoteDeadline
```

`requestHash = SHA-256(exact UTF-8 bytes of input)` — this binds the signed quote to a specific input, so a different input cannot be fulfilled with the same quote.

## Money flow

```
Owner A → USDC.approve(BudgetRail, amount)
Owner A → BudgetRail.fundSession(sessionId, amount)
  → USDC transferFrom(A, BudgetRail)

[quotes are issued, agent pays]

Agent B → BudgetRail.payForRequest(sessionId, reqId, reqHash, amount, deadline, sig)
  → signature verified against session.quoteSigner (D)
  → USDC transfer(session.provider, amount)   (always to C)

Owner A → BudgetRail.closeSession(sessionId)
  → USDC transfer(session.owner, refund)      (unspent returns to A)
```

## Off-chain fulfillment gate

`POST /api/fulfill` never returns a result from a quote alone. It independently verifies:

1. SHA-256(input) == quote.requestHash
2. EIP-712 signature valid against session.quoteSigner from the live contract
3. tx.status == success
4. tx.to == BudgetRail contract address (exact match)
5. PaymentSettled event emitted from BudgetRail (address check, not just topic)
6. All PaymentSettled fields match quote
7. ERC-20 Transfer from BudgetRail to provider C with exact amount
8. block.timestamp of the payment block <= quoteDeadline (uses onchain time, not wall-clock)

This means: a fake event from another contract, a wrong-token transfer, an altered input, or a payment after the deadline all result in a 400/402 rejection.

## Decimal handling

Arc has ONE USDC pool exposed two ways:
- ERC-20 view: 6 decimals (all session amounts, balances, and payouts)
- Native gas view: 18 decimals (gas fees only)

The contract and all API code use 6-decimal ERC-20 units exclusively. Native gas is separate from session accounting. The frontend uses `@/onchain-money` helpers to avoid hand-written decimal math.

## Key security properties

| Property | How it is enforced |
|----------|--------------------|
| Only agent B can call payForRequest | `if (msg.sender != session.agent) revert NotAgent()` |
| Only owner A can fund/close | `if (msg.sender != session.owner) revert NotOwner()` |
| Provider C is immutable | Set at `createSession`; never updated |
| Quote signer D is immutable | Set at `createSession`; never updated |
| No replay | `_requestPaid[sessionId][requestId]` boolean map |
| Budget cap | `newTotalSpent > session.totalFunded` → FundedBudgetExceeded |
| Per-payment cap | `amount > session.perPaymentCap` → PerPaymentCapExceeded |
| Checks-Effects-Interactions | State updated before all external token calls |
| Reentrancy | `nonReentrant` on `payForRequest` and `closeSession` |
| Off-chain input integrity | SHA-256(input) stored in PaymentSettled log, verified by API |
