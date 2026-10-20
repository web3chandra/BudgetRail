# BudgetRail — Complete System Reference

> One document covering what the application is, how every piece works, every file that was created, and what should be built next.

---

## Table of Contents

1. [What BudgetRail Is](#1-what-budgetrail-is)
2. [The Problem It Solves](#2-the-problem-it-solves)
3. [How It Works — End to End](#3-how-it-works--end-to-end)
4. [Roles and Trust Model](#4-roles-and-trust-model)
5. [Smart Contract — BudgetRail.sol](#5-smart-contract--budgetrailsol)
6. [EIP-712 Quote Signing](#6-eip-712-quote-signing)
7. [Provider API Server](#7-provider-api-server)
8. [Agent CLI](#8-agent-cli)
9. [React Frontend — Pages and Components](#9-react-frontend--pages-and-components)
10. [Frontend State Machine](#10-frontend-state-machine)
11. [Money Flow in Detail](#11-money-flow-in-detail)
12. [Environment Variables](#12-environment-variables)
13. [Every File Created — Annotated Directory Tree](#13-every-file-created--annotated-directory-tree)
14. [Test Suite Summary](#14-test-suite-summary)
15. [Deployed Contract](#15-deployed-contract)
16. [Security Model and Known Risks](#16-security-model-and-known-risks)
17. [How to Run Everything Locally](#17-how-to-run-everything-locally)
18. [CI Pipeline](#18-ci-pipeline)
19. [Future Improvements](#19-future-improvements)

---

## 1. What BudgetRail Is

BudgetRail is a **programmable USDC payment-session vault for software agents** deployed on the Arc blockchain. It lets a human owner (A) pre-fund a capped USDC budget on-chain, authorize a software agent (B) to spend from it, and pay a provider (C) per API call — all enforced by a non-upgradeable smart contract, with no trusted intermediary.

The first service wired to BudgetRail is **Document Insights v1**: a deterministic text-analysis API that charges $0.05 USDC per call. The provider server will not return a result unless it can prove, by independently reading the Arc blockchain, that the payment was made and settled.

The whole stack — contract, provider API, agent CLI, and 5-page React UI — was built in a single Arc Studio project.

---

## 2. The Problem It Solves

Software agents need to pay API providers per call in stablecoin. Three parties have conflicting interests:

| Party | Concern |
|-------|---------|
| Owner A (human) | Wants a hard budget cap, a per-call spending limit, and a guaranteed refund path. |
| Provider (C + D) | Wants non-repudiable, guaranteed settlement before releasing the result. |
| Agent B (software) | Should not need a blank allowance or a separate treasury. |

Traditional pay-per-call APIs solve none of these: they rely on API keys, off-chain billing, and manual refunds. BudgetRail solves all three with a single session-based on-chain vault:

- The **contract** enforces every cap — per-call and total — in Solidity, so no off-chain system can exceed them.
- The **provider** refuses to release a result until it has verified the on-chain `PaymentSettled` event and the ERC-20 `Transfer` log independently.
- The **owner** can close the session at any time and reclaim unspent USDC — no support ticket required.

---

## 3. How It Works — End to End

```
Owner A creates a session on-chain:
  → specifies agent B, provider payout wallet C, quote signer D,
    maxBudget, perPaymentCap, and expiresAt
  → session ID is assigned (starts at 1, auto-increments)

Owner A approves USDC spending and funds the session:
  → USDC.approve(BudgetRail, amount)
  → BudgetRail.fundSession(sessionId, amount)
  → USDC moves from Owner A's wallet into the BudgetRail contract

Agent B wants to use the Document Insights API:
  → POST /api/quotes  { sessionId, service, input }
  → Provider server reads the session from chain (validates it is open, funded, not expired)
  → Provider signs an EIP-712 PaymentQuote:
      { sessionId, requestId, requestHash=SHA256(input), amount=50000, quoteDeadline }
  → Returns the signed quote to agent B (no money moves here)

Agent B pays on-chain:
  → BudgetRail.payForRequest(sessionId, requestId, requestHash, amount, quoteDeadline, signature)
  → Contract verifies: EIP-712 signature, per-call cap, budget remaining, no replay, not expired
  → Contract transfers USDC from vault to session.provider (wallet C)
  → Contract emits PaymentSettled event

Agent B submits fulfillment request:
  → POST /api/fulfill  { input, quote, txHash }
  → Provider fetches the tx receipt from chain
  → Runs 14 independent checks (see Security section)
  → Only if ALL pass: returns Document Insights result

Owner A closes the session (any time):
  → BudgetRail.closeSession(sessionId)
  → Unspent USDC refunded back to Owner A's wallet
  → Session marked closed permanently
```

---

## 4. Roles and Trust Model

| Role | Label | Where the key lives | What they can do |
|------|-------|---------------------|-----------------|
| Owner | A | Browser wallet (MetaMask, Rabby, etc.) | Create sessions, fund sessions, close sessions |
| Agent | B | Local keyfile in `agent/` | Call `payForRequest`; no other contract permissions |
| Provider payout | C | Address only — no private key used in contract | Passive USDC recipient; cannot interact with contract |
| Quote signer | D | `QUOTE_SIGNER_PRIVATE_KEY` on provider server | Signs EIP-712 quotes; cannot redirect funds (C is immutable) |

**Key isolation:** Key D is separate from wallet C deliberately. If D is leaked, an attacker can issue forged quotes and drain a session's funded budget, but they cannot redirect the USDC to a different address — it always goes to C, which was locked at session creation.

---

## 5. Smart Contract — BudgetRail.sol

**File:** `contracts/BudgetRail.sol`
**Compiler:** Solidity ^0.8.24, compiled 0.8.28, EVM Paris, optimizer 200 runs
**Deployed:** Arc Testnet `0xf6a13df15ad93c2e2968e1d69c53894a923bda21`

### Session struct

```solidity
struct Session {
    address owner;         // A — can fund and close
    address agent;         // B — can call payForRequest
    address provider;      // C — receives USDC; immutable after creation
    address quoteSigner;   // D — EIP-712 signer address; immutable after creation
    uint96  maxBudget;     // max total USDC allowed (6-decimal ERC-20 units)
    uint96  perPaymentCap; // max per single payForRequest call
    uint96  totalFunded;   // cumulative USDC deposited via fundSession
    uint96  totalSpent;    // cumulative USDC paid via payForRequest
    uint64  expiresAt;     // unix timestamp; 0 = never expires
    bool    closed;        // permanent close flag; can never be reopened
}
```

All amounts are in 6-decimal USDC ERC-20 units. `uint96` can hold up to ~$79 trillion worth — no practical overflow risk.

### Storage layout

```
mapping(uint256 => Session)                      _sessions
mapping(uint256 => mapping(bytes32 => bool))     _requestPaid
mapping(address => uint256[])                    _ownerSessions
uint256                                          _nextSessionId   // starts at 1
IERC20 immutable                                 USDC_TOKEN
address immutable                                USDC_ADDRESS
```

`_requestPaid` is the replay guard — once a `requestId` is paid in a session, it can never be reused (even across different sessions for the same requestId).

### Public functions

| Function | Who calls it | What it does |
|----------|-------------|-------------|
| `createSession(agent, provider, signer, maxBudget, perPaymentCap, expiresAt)` | Owner A | Creates a new session. Returns the new sessionId. |
| `fundSession(sessionId, amount)` | Owner A | Transfers USDC from owner into the vault. Bounded by `maxBudget`. Can be called multiple times. |
| `payForRequest(sessionId, requestId, requestHash, amount, quoteDeadline, signature)` | Agent B | Verifies EIP-712 sig, deducts budget, transfers USDC to provider C. |
| `closeSession(sessionId)` | Owner A | Marks session closed, refunds unspent USDC to owner A. |

### View functions

| Function | Returns |
|----------|---------|
| `getSession(sessionId)` | Full Session struct |
| `availableBalance(sessionId)` | `totalFunded - totalSpent` |
| `ownerSessionCount(owner)` | Number of sessions created by owner |
| `sessionIdsByOwner(owner, offset, limit)` | Paginated slice of session IDs |
| `USDC_ADDRESS()` | ERC-20 USDC address (immutable) |
| `decimals()` | Always 6 |

### Custom errors (all 18)

```
ZeroAddress               — constructor arg or session param is address(0)
InvalidBudget             — maxBudget == 0
InvalidPerPaymentCap      — perPaymentCap == 0 or > maxBudget
ExpiryInPast              — expiresAt <= block.timestamp (and not 0)
SessionNotFound           — session ID does not exist
NotOwner                  — caller is not session.owner
NotAgent                  — caller is not session.agent
SessionAlreadyClosed      — session.closed == true
SessionExpired            — block.timestamp > session.expiresAt
ZeroAmount                — funding amount == 0
BudgetExceeded            — totalFunded + amount > maxBudget
FundedBudgetExceeded      — newTotalSpent > totalFunded
LifetimeBudgetExceeded    — newTotalSpent > maxBudget
PerPaymentCapExceeded     — amount > perPaymentCap
QuoteExpired              — block.timestamp > quoteDeadline
QuoteDeadlineExceedsSession — quoteDeadline > expiresAt (non-zero expiry)
RequestAlreadyPaid        — requestId already paid in this session
InvalidSignature          — ecrecover result != session.quoteSigner
```

### Events

```solidity
SessionCreated(uint256 indexed sessionId, address indexed owner, address indexed agent, ...)
SessionFunded(uint256 indexed sessionId, address indexed funder, uint256 amount, ...)
PaymentSettled(uint256 indexed sessionId, bytes32 indexed requestId, address indexed agent, ...)
SessionClosed(uint256 indexed sessionId, address indexed owner, uint256 refundAmount)
```

### Security properties enforced in Solidity

- `nonReentrant` on `payForRequest` and `closeSession` (OpenZeppelin ReentrancyGuard)
- Checks-Effects-Interactions pattern throughout (state written before external ERC-20 calls)
- `ecrecover` is never called with a zero address
- `_requestPaid` guard is set before the USDC transfer (prevents reentrancy replay)
- No `delegatecall`, no `selfdestruct`, no upgradeable proxy, no admin sweep function

---

## 6. EIP-712 Quote Signing

**File:** `provider/src/lib/eip712.ts`

Every payment starts with a quote. The quote is a signed authorization from the provider (key D) that says: "I authorize spending `amount` USDC from session `sessionId` for this specific input."

### Domain

```
name:              "BudgetRail"
version:           "1"
chainId:           5042002  (testnet) / 5042 (mainnet)
verifyingContract: <deployed BudgetRail address>
```

### Struct type

```
PaymentQuote(
  uint256 sessionId,
  bytes32 requestId,
  bytes32 requestHash,
  uint256 amount,
  uint64  quoteDeadline
)
```

### Field semantics

| Field | Type | Meaning |
|-------|------|---------|
| `sessionId` | uint256 | The session being paid against |
| `requestId` | bytes32 | 32 bytes of cryptographic randomness — unique per quote, used as replay guard |
| `requestHash` | bytes32 | `SHA-256(exact UTF-8 bytes of input)` — binds the quote to the specific document |
| `amount` | uint256 | USDC in 6-decimal ERC-20 base units (50000 = $0.05) |
| `quoteDeadline` | uint64 | Unix timestamp after which the quote expires (min(now + 600s, session.expiresAt)) |

The `requestHash` is the critical field: it means a quote for document X cannot be used to pay for document Y, and the provider can verify the input that was actually paid for.

---

## 7. Provider API Server

**Directory:** `provider/`
**Runtime:** Bun
**Port:** 3001
**Start command:** `bun run provider/src/index.ts` (with env vars set)

The provider server is a lightweight HTTP API with three routes. It never stores state between requests — all verification is against live chain reads.

### Files

| File | Purpose |
|------|---------|
| `provider/src/index.ts` | Bun.serve entry point, CORS headers, route dispatch |
| `provider/src/lib/config.ts` | Load and validate all env vars at startup; fail fast |
| `provider/src/lib/eip712.ts` | Sign a PaymentQuote with key D; derive address from private key |
| `provider/src/lib/insights.ts` | Deterministic text analysis engine (Document Insights v1) |
| `provider/src/lib/onchain.ts` | viem public client; `getSession`, `decodePaymentSettledLog`, `decodeTransferLog` |
| `provider/src/lib/ratelimit.ts` | In-memory per-session rate limiter (10 req/min default) |
| `provider/src/routes/health.ts` | GET /api/health |
| `provider/src/routes/quotes.ts` | POST /api/quotes |
| `provider/src/routes/fulfill.ts` | POST /api/fulfill |

### GET /api/health

Returns server status: chain ID, contract address, payout address, quote signer address, service name, price, USDC address, latest block, and whether the RPC is reachable. **Never returns a private key.**

```json
{
  "status": "ok",
  "chainId": 5042002,
  "contractAddress": "0xf6a13df15ad93c2e2968e1d69c53894a923bda21",
  "providerPayout": "0x1cd4...",
  "quoteSignerAddress": "0x1b20...",
  "service": "document-insights-v1",
  "priceBaseUnits": "50000",
  "usdcAddress": "0x3600000000000000000000000000000000000000",
  "usdcDecimals": 6,
  "network": "testnet",
  "latestBlock": "67681512",
  "rpcOk": true
}
```

### POST /api/quotes

Accepts `{ sessionId, service, input }`. The server:
1. Validates input size (<= 8 KiB) and service name.
2. Reads the session from the Arc chain (sessionId exists, open, funded, not expired, provider + signer match config).
3. Verifies the session has enough available balance for one more payment.
4. Computes `requestHash = SHA-256(input)`.
5. Generates a cryptographically random `requestId` (32 bytes).
6. Signs the EIP-712 struct with key D.
7. Returns the full `SignedQuote` — the agent submits this to `payForRequest`.

**The server always sets `amount` to the configured price. Any user-supplied amount field is ignored.**

### POST /api/fulfill

Accepts `{ input, quote, txHash }`. Runs 14 independent verification checks:

1. `SHA-256(input) == quote.requestHash` (input integrity)
2. `quote.chainId`, `contractAddress`, `providerPayout`, `quoteSignerAddress`, `amount`, `service` all match server config
3. EIP-712 signature valid against `session.quoteSigner` read live from chain
4. `tx.status == 1` (transaction succeeded)
5. `tx.to == BudgetRail contract address` (exact match — not just any contract)
6. `PaymentSettled` event emitted **from the BudgetRail address** (not just the same topic from another contract)
7. `PaymentSettled.sessionId`, `.requestId`, `.requestHash`, `.provider`, `.amount`, `.quoteDeadline` all match the quote
8. `tx.from == PaymentSettled.agent` (agent consistency)
9. ERC-20 `Transfer` from BudgetRail to provider C with exact amount
10. `block.timestamp` of the payment block `<=` `quoteDeadline` (on-chain time, not wall-clock)
11. Input size within bounds
12. `txHash` format valid
13. All required quote fields present and correct type
14. All BigInt fields parseable

**If all 14 pass**, the server computes `computeInsights(input)` and returns the result with a payment receipt. If any check fails, it returns a 400 or 402 with a human-readable error. **No result is ever returned without proof of payment.**

### Document Insights v1

**File:** `provider/src/lib/insights.ts`

A deterministic text-analysis engine. Identical input always produces identical output. No LLM, no external API, no non-determinism.

Metrics computed:
- `wordCount`, `sentenceCount`, `paragraphCount`, `characterCount`
- `avgWordsPerSentence`, `avgSentencesPerParagraph`
- `top10Keywords` — by frequency, stop-words excluded (170 common English stop-words)
- `frequencyTable` — all non-stop tokens
- `extractiveSummary` — first sentence of each paragraph (up to 3)
- `readabilityTier` — "simple" (<12 avg words/sentence), "moderate" (<20), "complex" (>=20)

---

## 8. Agent CLI

**Directory:** `agent/`
**Runtime:** Bun
**Entry point:** `agent/src/demo.ts`
**Tests:** `agent/src/test/agent.test.ts` (15 tests)

The agent CLI is a TypeScript command-line tool that demonstrates the full Agent B payment flow:

1. Load config from env (`AGENT_PRIVATE_KEY`, `PROVIDER_API_URL`, `BUDGET_RAIL_ADDRESS`).
2. Read the session from chain (validate it exists and is open).
3. POST `/api/quotes` with the input text.
4. Verify the returned quote locally (EIP-712 signature, amount, chainId, contract, signer).
5. Call `BudgetRail.payForRequest` on-chain via viem.
6. Wait for transaction receipt.
7. POST `/api/fulfill` with the receipt.
8. Print the Document Insights result.

### Agent files

| File | Purpose |
|------|---------|
| `agent/src/demo.ts` | Full end-to-end demo script |
| `agent/src/lib/chain.ts` | viem wallet client; `readSession`, `payForRequest`, `waitForReceipt` |
| `agent/src/lib/eip712verify.ts` | Local quote signature verification (before paying) |
| `agent/src/lib/config.ts` | Load agent config from env |
| `agent/src/test/agent.test.ts` | 15 unit tests (A01–A12, C01–C03) |
| `agent/samples/` | Sample input documents for demo |

---

## 9. React Frontend — Pages and Components

**Directory:** `src/`
**Framework:** React 18, Vite 6, TypeScript, Tailwind CSS v3
**Web3:** wagmi v2, viem v2, ConnectKit
**Chain:** Arc Testnet (chain ID 5042002)

The frontend is a 5-page application. The user connects their MetaMask (or any injected) wallet once via ConnectKit and can then use all pages.

### App.tsx — Router and layout

**File:** `src/App.tsx`

The top-level component. Manages routing between the 5 pages, renders the navigation menu and the wallet connection button. On Arc Testnet, USDC is also the native gas token — the app shows the USDC balance, not a separate ETH balance.

### Page: Dashboard

**File:** `src/pages/Dashboard.tsx`

The home screen. Shows:
- All sessions created by the connected wallet (reads `ownerSessionCount` + `sessionIdsByOwner` + `getSession` in a batch).
- Session status: open, expired, closed.
- Available balance per session.
- Quick links to Manage Session and Playground.
- A "recent payments" feed using `eth_getLogs` scanned from the deploy block forward.

### Page: Create Budget

**File:** `src/pages/CreateBudget.tsx`

A 3-step wizard that creates and funds a new session:
- **Step 1 (Create session):** Enter agent wallet B address, expiry date/time, max budget (USDC), and per-call cap. Uses `simulateContract` as a preflight check before opening the wallet.
- **Step 2 (Approve USDC):** Approves the BudgetRail contract to spend the funding amount via `USDC.approve`.
- **Step 3 (Fund session):** Calls `BudgetRail.fundSession`. USDC moves from the owner's wallet into the contract.

The page shows a "Provider not configured" amber banner if `VITE_PROVIDER_PAYOUT` or `VITE_QUOTE_SIGNER` are zero — this blocks all three steps because the contract would revert with `ZeroAddress`.

All form values are persisted to localStorage (keyed by chainId + wallet address + contract), so a page refresh does not lose the form draft. Pending transaction hashes are also stored so the UI can recover mid-flow after a refresh.

### Page: Playground

**File:** `src/pages/Playground.tsx`

An interactive API testing panel. The user (acting as agent B, or testing as the owner if they used the same address):
1. Enters a session ID.
2. Pastes any text.
3. Clicks "Request Quote" — calls POST /api/quotes.
4. Reviews the quote (session ID, amount, deadline).
5. Clicks "Pay" — calls `BudgetRail.payForRequest` on-chain.
6. After confirmation, clicks "Get Result" — calls POST /api/fulfill.
7. Sees the Document Insights result: word count, keywords, readability tier, summary.

### Page: Manage Session

**File:** `src/pages/ManageSession.tsx`

Shows the full session struct for a given session ID:
- All session parameters.
- Available balance.
- Close session button — calls `BudgetRail.closeSession`, which transfers unspent USDC back to the owner.
- Shows a clear error message if the session is already closed or the caller is not the owner.

### Page: Payment History

**File:** `src/pages/PaymentHistory.tsx`

Scans `PaymentSettled` events from the BudgetRail contract using `eth_getLogs`, with a bounded scan starting at the deploy block (67538363). Shows:
- Per-event: session ID, request ID, amount (USDC), block number, transaction hash.
- Filtered by connected wallet (only sessions the user owns, or all if they switch the filter).
- Links to the Arc Testnet block explorer per transaction.

### Shared library files

| File | Purpose |
|------|---------|
| `src/lib/budgetRail.ts` | Contract ABI (from compiled artifact), contract address from env, `PROVIDER_CONFIGURED` flag, `providerConfigError()`, `readAddr()`, `DEPLOY_BLOCK_TESTNET` constant (67538363n) |
| `src/lib/parseOnchainError.ts` | Decodes raw 4-byte revert selectors from viem errors; maps all 18 custom errors to human-readable strings; detects wallet rejection (code 4001); handles generic patterns (insufficient funds, network error, dropped tx) |
| `src/lib/format.ts` | USDC amount formatting, address truncation, timestamp formatting |
| `src/hooks/useSessionFlow.ts` | Full 8-state transaction lifecycle hook (see next section) |
| `src/onchain-facts.ts` | Chain registry: chain IDs, RPC URLs, USDC addresses, CCTP/Gateway contracts |
| `src/onchain-money.ts` | USDC decimal math helpers — `parseUsdc`, `formatUsdc`, `usdcToGasToken` |
| `src/onchain-wait.ts` | Circle transaction state machine and polling helpers |
| `src/config.ts` | wagmi config: Arc Testnet + mainnet (for ENS), ConnectKit |
| `src/main.tsx` | App entry point — WagmiProvider, QueryClientProvider, ConnectKitProvider, Sonner toaster |

### Regression tests

**File:** `src/test/budgetRail.test.ts` (53 tests)

Covers:
- `parseUsdcUnits` — 9 cases (valid amounts, zero, negative, NaN, rounding)
- `isValidAddress` — 7 cases (valid, zero, too-short, no-prefix, invalid hex)
- `parseOnchainError` — all 18 BudgetRail custom error selectors, wallet rejection, generic patterns
- Form validation math — per-call cap vs max budget boundary cases
- `providerConfigError` — all zero/non-zero combinations
- Block-range arithmetic — deploy-block lower bound, window math, no fromBlock > toBlock
- localStorage key versioning

---

## 10. Frontend State Machine

**File:** `src/hooks/useSessionFlow.ts`

Every wallet interaction in `CreateBudget` uses an 8-state machine rather than ad-hoc boolean flags. This prevents the stuck-UI bug where an error during confirmation left the button permanently disabled.

### States

| State | Meaning |
|-------|---------|
| `idle` | Nothing in progress. Form is editable. |
| `validating` | `simulateContract` preflight running. Button shows spinner. |
| `awaiting_signature` | Wallet modal is open. User must sign or reject. |
| `submitted` | Transaction hash received. Waiting for mining. |
| `confirming` | Receipt arrived, awaiting block confirmation. |
| `confirmed` | Transaction finalized. Step complete. |
| `failed` | Error at any stage. Shows human-readable message + Retry button. |
| `cancelled` | User rejected in wallet. Shows "Cancelled" message. |

### Three steps, each with their own state instance

1. `createSession` — calls `BudgetRail.createSession`, extracts `SessionCreated` event to get the new session ID.
2. `approve` — calls `USDC.approve(BudgetRail, amount)`.
3. `fundSession` — calls `BudgetRail.fundSession(sessionId, amount)`.

Each step has its own `useWriteContract` + `useWaitForTransactionReceipt` hook pair. All `isError` and `error` destructures are consumed — no more silent stuck states.

### simulateContract preflight

Before any wallet modal opens, `publicClient.simulateContract` runs the call against the node with the user's current address and state. If the contract would revert (e.g. `ZeroAddress`, `InvalidBudget`, `ExpiryInPast`), the error is decoded by `parseOnchainError` and shown as a text message — no gas wasted, no transaction broadcast.

### localStorage persistence

Draft form values are stored under key `br:draft:v1:{chainId}:{account}:{contract}` so a page refresh does not lose the entered values. Pending transaction hashes are stored under `br:hashes:v1:{...}` so the hook can recover mid-flow: it reads the stored hash, fetches the receipt from chain, and resumes at the correct step.

---

## 11. Money Flow in Detail

```
USDC ERC-20 (0x3600...0000, 6 decimals)

1. Owner A calls: USDC.approve(BudgetRail, fundAmount)
   → Allows BudgetRail to pull up to fundAmount USDC from A

2. Owner A calls: BudgetRail.fundSession(sessionId, fundAmount)
   → BudgetRail calls USDC.transferFrom(A, BudgetRail, fundAmount)
   → session.totalFunded += fundAmount
   → Emits SessionFunded

   USDC is now inside BudgetRail, locked to sessionId.
   No admin can move it except via payForRequest or closeSession.

3. Agent B calls: BudgetRail.payForRequest(sessionId, ...)
   → Signature verified, all caps checked, replay guard set
   → BudgetRail calls USDC.transfer(session.provider, amount)
   → session.totalSpent += amount
   → Emits PaymentSettled

   USDC moves from BudgetRail to Provider wallet C.
   No other address can be the recipient — it is read from session.provider,
   which was set at createSession and is immutable.

4. Owner A calls: BudgetRail.closeSession(sessionId)
   → refund = session.totalFunded - session.totalSpent
   → BudgetRail calls USDC.transfer(session.owner, refund)
   → session.closed = true
   → Emits SessionClosed

   Remaining USDC returns to Owner A. Session is permanently closed.
```

On Arc, USDC is also the native gas token. Gas fees are paid from the same USDC balance but are NOT session funds — they are a separate pool managed by the Arc protocol. Session accounting only touches 6-decimal ERC-20 balances via the contract.

---

## 12. Environment Variables

### Frontend (`.env` in project root)

| Variable | Description | Who sets it |
|----------|-------------|-------------|
| `VITE_BUDGET_RAIL_ADDRESS` | Deployed BudgetRail contract address | Operator (set automatically in sandbox) |
| `VITE_PROVIDER_PAYOUT` | Provider payout wallet C address (public) | Operator |
| `VITE_QUOTE_SIGNER` | Quote signer D public address (public) | Operator |
| `VITE_PROVIDER_API_URL` | Base URL for provider API calls (use `/api` for local Vite proxy) | Operator |

All `VITE_*` vars are public — they are embedded in the browser bundle. **Never put a private key in a VITE_ variable.**

### Provider server (set in shell or secrets manager)

| Variable | Description | Required |
|----------|-------------|----------|
| `PROVIDER_NETWORK` | `testnet` or `mainnet` | No (default: testnet) |
| `PROVIDER_PAYOUT_ADDRESS` | Wallet C address — receives USDC | Yes |
| `QUOTE_SIGNER_PRIVATE_KEY` | Key D private key — signs quotes | Yes |
| `BUDGET_RAIL_TESTNET_ADDRESS` | Override default testnet contract address | No |
| `BUDGET_RAIL_MAINNET_ADDRESS` | Mainnet contract address | Yes (mainnet only) |
| `ARC_TESTNET_RPC_URL` | Override default testnet RPC | No |
| `ARC_MAINNET_RPC_URL` | Mainnet RPC URL | Yes (mainnet only) |
| `PRICE_PER_CALL_BASE_UNITS` | Price per call in 6-dec units | No (default: 50000 = $0.05) |
| `QUOTE_WINDOW_SECONDS` | Quote validity window | No (default: 600 = 10 min) |
| `MAX_INPUT_BYTES` | Max input document size | No (default: 8192 = 8 KiB) |
| `RATE_LIMIT_PER_MINUTE` | Max quotes per session per minute | No (default: 10) |
| `PORT` | Provider API port | No (default: 3001) |

### Agent CLI (set in shell)

| Variable | Description |
|----------|-------------|
| `AGENT_PRIVATE_KEY` | Key B private key — signs payForRequest txns |
| `PROVIDER_API_URL` | Full URL of provider API (`http://localhost:3001`) |
| `BUDGET_RAIL_ADDRESS` | Contract address |

---

## 13. Every File Created — Annotated Directory Tree

```
/
├── contracts/
│   ├── BudgetRail.sol                    Main smart contract — session vault, payment, refund
│   ├── test/
│   │   └── BudgetRail.t.sol              Foundry test suite (57 functional + 2 invariants = 59 tests)
│   ├── script/
│   │   ├── Create2Factory.sol            Deploy helper for deterministic addresses
│   │   └── DeployCreate2.s.sol           Foundry deploy script
│   ├── out/
│   │   └── BudgetRail.sol/
│   │       └── BudgetRail.json           Compiled Foundry artifact — ABI + bytecode
│   └── contract-metadata/               Foundry metadata dir
│
├── provider/                             Provider API server (Bun/TypeScript)
│   ├── src/
│   │   ├── index.ts                      Entry point — Bun.serve, CORS, route dispatch
│   │   ├── lib/
│   │   │   ├── config.ts                 Env var loading and validation (fail fast at startup)
│   │   │   ├── eip712.ts                 Sign PaymentQuote; derive address from private key
│   │   │   ├── insights.ts               Document Insights v1 — deterministic text analysis
│   │   │   ├── onchain.ts                viem public client; getSession; decode event logs
│   │   │   └── ratelimit.ts              In-memory per-session rate limiter
│   │   └── routes/
│   │       ├── health.ts                 GET /api/health
│   │       ├── quotes.ts                 POST /api/quotes — validate, sign, return quote
│   │       └── fulfill.ts                POST /api/fulfill — verify 14 checks, return result
│   └── test/
│       ├── eip712.test.ts                11 tests: signing, address derivation, domain matching
│       ├── insights.test.ts              13 tests: all metrics, edge cases, determinism
│       ├── quotes.test.ts                19 tests: input validation, chain reads, rate limiting
│       └── fulfill.test.ts               21 tests: all 14 verification checks, idempotency
│
├── agent/                                Agent CLI (Bun/TypeScript)
│   ├── src/
│   │   ├── demo.ts                       Full end-to-end demo script
│   │   ├── lib/
│   │   │   ├── chain.ts                  viem wallet client; readSession; payForRequest
│   │   │   ├── eip712verify.ts           Local quote verification before paying
│   │   │   └── config.ts                 Load agent config from env
│   │   └── test/
│   │       └── agent.test.ts             15 tests: A01–A12 quote verification, C01–C03 config
│   └── samples/                          Sample input documents for demo
│
├── src/                                  React frontend (Vite + wagmi + ConnectKit)
│   ├── App.tsx                           Router, navigation, wallet connection
│   ├── main.tsx                          Entry — WagmiProvider, QueryClientProvider, Toaster
│   ├── config.ts                         wagmi config: Arc Testnet + mainnet
│   ├── index.css                         Tailwind directives
│   ├── onchain-facts.ts                  Chain registry (Arc Studio generated — do not edit)
│   ├── onchain-money.ts                  USDC decimal math helpers (Arc Studio generated)
│   ├── onchain-wait.ts                   Transaction state machine (Arc Studio generated)
│   ├── tracing.ts                        RPC trace capture for Tracing panel
│   ├── console-capture.ts                Console log capture for debugging
│   ├── vite-env.d.ts                     Vite env type declarations
│   ├── pages/
│   │   ├── Dashboard.tsx                 Session list + recent payments
│   │   ├── CreateBudget.tsx              3-step create + approve + fund wizard
│   │   ├── Playground.tsx                Interactive quote + pay + fulfill demo
│   │   ├── ManageSession.tsx             Session detail + close session
│   │   └── PaymentHistory.tsx            eth_getLogs PaymentSettled event feed
│   ├── hooks/
│   │   └── useSessionFlow.ts             8-state tx lifecycle machine; localStorage persistence
│   ├── lib/
│   │   ├── budgetRail.ts                 ABI, contract address, provider config guard
│   │   ├── parseOnchainError.ts          4-byte selector decoder; human-readable error map
│   │   └── format.ts                     USDC formatting, address truncation
│   └── test/
│       └── budgetRail.test.ts            53 frontend regression tests (Bun)
│
├── docs/
│   ├── MASTER.md                         THIS FILE — complete system reference
│   ├── ARCHITECTURE.md                   System architecture diagram and design rationale
│   ├── SECURITY.md                       Threat model, findings (H/M/L/I), checklist
│   ├── API.md                            Provider API reference (request/response schemas)
│   ├── TEST-REPORT.md                    Actual test results from sandbox runs
│   ├── DEPLOYMENT.md                     Operator runbook — testnet done, mainnet steps
│   ├── DEMO-SCRIPT.md                    Step-by-step demo walkthrough
│   ├── BudgetRail-contract.md            Solidity contract technical reference
│   └── arc-studio-provenance.md          Deployment provenance: addresses, tx hashes, evidence
│
├── evidence/
│   ├── testnet.json                      Testnet deploy facts and lifecycle checklist
│   └── mainnet.json                      Mainnet evidence placeholder (populate after deploy)
│
├── scripts/
│   ├── check.sh                          Lint + typecheck runner
│   ├── compass-deploy.ts                 Arc Studio contract deploy helper
│   ├── compass-deploy-helpers.ts         Deploy helper utilities
│   ├── self-deploy.ts                    Self-deploy script (Mode 2)
│   └── fetch-abi.ts                      ABI extraction helper
│
├── .github/
│   └── workflows/
│       └── ci.yml                        CI pipeline — all tests on every push
│
├── AGENTS.md                             Project memory (Arc Studio reads this each session)
├── README.md                             Project overview and quick start
├── .env                                  Environment variables (gitignored)
├── env.example.txt                       Documented env var template
├── foundry.toml                          Foundry compiler and optimizer config
├── remappings.txt                        Foundry import remappings
├── vite.config.ts                        Vite config — alias, proxy to provider, allowedHosts
├── tailwind.config.js                    Tailwind config
├── tsconfig.json                         TypeScript config (excludes test dir from tsc)
├── package.json                          Frontend scripts
└── bun.lock                              Lockfile
```

---

## 14. Test Suite Summary

All tests run without a funded wallet, live RPC, or secrets. The Foundry tests use a local EVM. Provider and agent tests mock chain reads.

| Suite | Command | Tests | Pass | Fail |
|-------|---------|-------|------|------|
| Contract — Foundry functional | `bun run contracts:test` | 57 | 57 | 0 |
| Contract — Foundry invariants | `bun run contracts:test` | 2 | 2 | 0 |
| Provider API — Bun | `cd provider && bun test` | 64 | 64 | 0 |
| Agent CLI — Bun | `cd agent && bun test src/test/` | 15 | 15 | 0 |
| Frontend — Bun | `bun run frontend:test` | 53 | 53 | 0 |
| Frontend lint + tsc | `bun run check` | — | 0 errors | — |
| **Total** | | **191** | **191** | **0** |

### What each contract test category covers

| Category | Test IDs | What is verified |
|----------|----------|-----------------|
| Immutability | SC01 | `USDC_TOKEN` and `USDC_ADDRESS` cannot change |
| Session IDs | SC02 | Counter starts at 1, increments monotonically |
| Isolation | SC03, SC15 | Sessions never interfere with each other |
| Decimal correctness | SC04, SC20 | 6-decimal ERC-20, distinct from 18-dec native gas |
| Funding | SC05, SC06 | Bounded allowance, multi-deposit |
| Payment | SC07, SC08 | Valid EIP-712 quote triggers exact transfer |
| Per-payment cap | SC09 | Exact-cap succeeds; cap+1 reverts |
| Budget exhaustion | SC10, SC11 | Last payment drains; underfunded reverts |
| Close and refund | SC12–SC14 | Partial refund, full refund, post-expiry close |
| Events | SC16 | All 4 events decode correctly |
| Pagination | SC17 | `sessionIdsByOwner` slice and offset |
| Fuzz | SC18, SC19 | Amount and budget fuzz (512 runs each) |
| Zero params | SC21–SC28 | All zero-address and zero-value constructor/session args |
| Access control | SC29–SC31 | Non-owner fund, non-owner close, non-agent pay |
| Signature attacks | SC32–SC39 | Wrong signer, wrong chainId, wrong contract, 8 field mutations |
| Replay | SC40, SC41 | Duplicate requestId in same session; same ID across sessions |
| Expiry | SC42, SC43 | Expired quote; expired session |
| Post-close | SC44 | Spend after close reverts |
| Overfunding | SC45 | Above maxBudget reverts |
| Large amounts | SC46 | uint96 limits |
| Reentrancy | SC47 | ReentrantToken confirms nonReentrant |
| Double close | SC48 | Second closeSession reverts |
| Rollback | SC49, SC50 | Failed transfer/refund rolls back state |
| Fixed provider | SC51 | Payment always goes to session.provider, never elsewhere |
| Constructor | SC52 | Zero USDC address reverts |
| Missing allowance | SC53 | Fund without ERC-20 approve reverts |
| No ETH | SC54 | Plain ETH send reverts |
| Blocklist | SC55 | Circle blocklisted provider blocks payment mid-session |
| viem vector | SC56 | EIP-712 typehash matches viem implementation cross-check |
| Unicode | SC57 | Unicode requestHash handled identically to ASCII |
| Invariants | — | totalFunded ≤ maxBudget; totalSpent ≤ totalFunded (256 seqs × 128k calls) |

---

## 15. Deployed Contract

| Field | Value |
|-------|-------|
| Network | Arc Testnet |
| Chain ID | 5042002 |
| Contract address | `0xf6a13df15ad93c2e2968e1d69c53894a923bda21` |
| Deploy transaction | `0xf33cb9096a45c5cc083fbee4366384f4257f509ab94fe46ec4291e775bc4a5d9` |
| Deploy block | 67538363 (hex: 0x4068dbb) |
| Deploy date | 2026-10-16T18:01:47.925Z |
| Constructor arg | `0x3600000000000000000000000000000000000000` (Arc USDC ERC-20) |
| Explorer | https://explorer.testnet.arc.io/address/0xf6a13df15ad93c2e2968e1d69c53894a923bda21 |
| Verified | USDC_ADDRESS() and decimals() confirmed by eth_call |

**USDC on Arc:**

| Property | Value |
|----------|-------|
| ERC-20 address | `0x3600000000000000000000000000000000000000` (same testnet and mainnet) |
| ERC-20 decimals | 6 |
| Native gas decimals | 18 |
| Pool | ONE pool — USDC is also the native gas token. Not two separate assets. |

---

## 16. Security Model and Known Risks

### What the contract enforces (cannot be bypassed)

- Hard budget cap per session (`maxBudget`) — no payment can exceed it.
- Per-call spending limit (`perPaymentCap`) — single-call max, enforced in Solidity.
- Only agent B can call `payForRequest` — address check, not a key check.
- Only owner A can fund or close — address check.
- Provider wallet C is immutable — set at creation, never changeable.
- Quote signer D is immutable — set at creation, never changeable.
- Every `requestId` is a one-time token — once paid, permanently blocked.
- Reentrancy guard on all state-changing + external-call functions.
- No admin, no upgrade, no sweep — the contract cannot be modified after deploy.

### Known risks and mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Token blocklist (Circle blocklists owner or provider) | HIGH | No fix possible without admin key. Use small sessions; never commit material funds. |
| Quote signer key D compromise | HIGH | Attacker can drain the funded budget within caps. Store D in a hardware security module or secrets manager. Never in .env on disk. |
| Block-timestamp manipulation at expiry | MEDIUM | Use expiry windows >1 minute. Avoid sessions expiring within 15 seconds of cutoff. |
| In-memory rate limiter resets on restart | MEDIUM | Replace with Redis in production. |
| CORS is open (`*`) | MEDIUM | Restrict to known frontend origin in production. |
| `availableBalance` ignores session expiry | LOW | Callers must check `expiresAt` and `closed` independently. UI and provider do this. |
| Unsolicited USDC sent to contract address is locked | LOW | Always fund via `fundSession`. No recovery path by design (no admin sweep). |
| Large `limit` in `sessionIdsByOwner` | LOW | Gas-constrained in practice. Frontend passes bounded limit. |
| Unstructured error logs in provider | LOW | Replace with pino/winston in production. |
| No third-party contract audit | HIGH | Do not use with material funds until an independent audit is complete. |

---

## 17. How to Run Everything Locally

### Prerequisites

- [Bun](https://bun.sh) >= 1.3
- [Foundry](https://book.getfoundry.sh) (`forge`, `cast`)
- A MetaMask (or compatible) browser wallet
- Arc Testnet USDC (click "Get test USDC" in the Arc Studio sidebar)

### Step 1: Install dependencies

```bash
bun install
cd provider && bun install && cd ..
cd agent && bun install && cd ..
```

### Step 2: Configure environment

The sandbox `.env` is already configured with:
```
VITE_BUDGET_RAIL_ADDRESS=0xf6a13df15ad93c2e2968e1d69c53894a923bda21
VITE_PROVIDER_PAYOUT=<generated payout address>
VITE_QUOTE_SIGNER=<generated quote signer address>
VITE_PROVIDER_API_URL=/api
```

For a fresh environment, copy `env.example.txt` to `.env` and fill in the values.

### Step 3: Start the provider server

```bash
PROVIDER_NETWORK=testnet \
PROVIDER_PAYOUT_ADDRESS=<wallet C address> \
QUOTE_SIGNER_PRIVATE_KEY=<key D — 0x-prefixed 32-byte hex> \
bun run provider/src/index.ts
# Listens on http://localhost:3001
```

Verify: `curl http://localhost:3001/api/health`

### Step 4: Start the frontend

```bash
bun run dev
# Opens http://localhost:5173
# Vite proxies /api/* to the provider on port 3001
```

### Step 5: Run all tests

```bash
bun run contracts:test       # 59 Foundry tests
cd provider && bun test      # 64 provider tests
cd agent && bun test src/test/  # 15 agent tests
bun run frontend:test        # 53 frontend tests
bun run check                # lint + typecheck (0 errors)
```

### Step 6: Demo flow

1. Open the app. Connect your wallet.
2. **Create Budget**: enter an agent address, expiry, budget ($1), per-call cap ($0.05). Submit all 3 steps. Note the session ID.
3. **Playground**: enter the session ID, paste any text, click Request Quote → Pay → Get Result.
4. **Manage Session**: enter the session ID, click Close Session to recover unspent USDC.
5. **Payment History**: see all PaymentSettled events.

---

## 18. CI Pipeline

**File:** `.github/workflows/ci.yml`

Runs on every push and pull request to `main`. Steps:

1. Install Foundry.
2. Install Bun.
3. `bun install` (frontend + scripts).
4. `cd provider && bun install` (provider).
5. `cd agent && bun install` (agent).
6. `forge build` — compile contracts.
7. `forge test` — 59 contract tests.
8. `cd provider && bun test` — 64 provider tests.
9. `cd agent && bun test src/test/` — 15 agent tests.
10. `bun run frontend:test` — 53 frontend tests.
11. `bun run check` — lint + typecheck (must exit 0).

No funded wallet, no live RPC, and no secrets are required for CI. All tests run against a local Foundry EVM and mock chain reads.

---

## 19. Future Improvements

These are concrete, prioritized enhancements for the next version of BudgetRail.

### High priority — required before production use

| Item | What to build |
|------|--------------|
| **Independent security audit** | Engage a third-party Solidity security firm to audit `BudgetRail.sol`. Currently the only blocker to production use with real funds. |
| **Redis-backed rate limiter** | Replace `provider/src/lib/ratelimit.ts` in-memory Map with a Redis store so the rate limit survives server restarts. Add `REDIS_URL` to provider env. |
| **Persistent CORS config** | Change `Access-Control-Allow-Origin: *` to match the deployed frontend URL. Add `ALLOWED_ORIGIN` env var. |
| **Structured logging** | Replace `console.log/error` in the provider with pino or winston with log-level filtering and structured JSON output. Never log private keys or input content. |
| **Secrets manager for key D** | Move `QUOTE_SIGNER_PRIVATE_KEY` from an env var on disk to AWS Secrets Manager, HashiCorp Vault, or a hardware security module. |

### Medium priority — expanded functionality

| Item | What to build |
|------|--------------|
| **Multiple services** | The contract already supports multiple provider types. Add a `service` enum to the session struct and route quotes to different price/logic handlers in the provider. |
| **Dynamic pricing** | Replace the fixed `PRICE_PER_CALL_BASE_UNITS` with a price oracle or a signed price tier from a pricing authority — same EIP-712 pattern, additional `priceVersion` field in the quote. |
| **Session delegation** | Allow owner A to designate a secondary address that can fund (but not close) a session — useful for multi-sig treasuries. |
| **ERC-4337 agent wallet** | Replace the raw private-key agent CLI with an ERC-4337 smart account (e.g. Circle Modular Wallets) so the agent can pay gas in USDC and batch `approve + payForRequest` in a single user operation. |
| **Fulfillment webhook** | Add a POST webhook callback URL to the quote request so the provider can push the result to the agent's server rather than requiring the agent to poll `/api/fulfill`. |
| **Session top-up cap** | Add a `maxTopUp` limit per `fundSession` call so the owner can restrict how much can be added after creation (useful for staged funding). |
| **Multi-provider sessions** | Allow a session to authorize N provider wallets, each with their own quote signer, so an agent can pay multiple services from one budget. |
| **On-chain price commitment** | Emit the `amount` and `pricePerCall` in the `SessionCreated` event so indexers and dashboards can verify the price was correct at creation time. |

### Lower priority — developer experience and ecosystem

| Item | What to build |
|------|--------------|
| **Hosted provider endpoint** | Deploy the provider server to a public URL (Fly.io, Railway) with a real TLS cert so the app works without a local server running. |
| **Agent SDK package** | Publish the agent library (`agent/src/lib/`) as an npm/bun package so third-party agents can integrate BudgetRail without reading the source. |
| **Session dashboard improvements** | Add a time-series USDC spend chart per session using the indexed `PaymentSettled` events. Show a projected "funds exhaustion" date based on recent spend rate. |
| **Quote expiry countdown** | In the Playground, show a live countdown to `quoteDeadline` so the user knows they must pay before the quote expires. |
| **Multi-wallet support** | Let the owner connect a Ledger or a Safe multi-sig for session creation and funding, while the agent uses a hot key. ConnectKit supports Safe via WalletConnect. |
| **Mainnet deploy and verification** | Deploy the contract to Arc Mainnet, verify source on the Arc block explorer, and update `evidence/mainnet.json` with real transaction hashes. |
| **Cross-chain sessions via CCTP** | Use Circle's Cross-Chain Transfer Protocol to let the owner fund a session from Ethereum, Base, or Polygon — the USDC bridges to Arc automatically before the session is created. |
| **Subgraph / indexer** | Build a The Graph subgraph (or a lightweight bun indexer with a SQLite/Postgres backend) that indexes all BudgetRail events so the dashboard can load instantly without `eth_getLogs` scans. |
| **Mobile wallet support** | Add WalletConnect v2 to the wagmi config so mobile wallets (Coinbase Wallet, Rainbow) can be used on the frontend. |
| **Gasless transactions via paymaster** | Integrate Circle's ERC-4337 Gas Station paymaster so new users do not need Arc USDC before their first transaction — the first session creation is sponsored. |

---

*This document is the single source of truth for the BudgetRail system. Update it when contracts, APIs, file structure, or architecture change.*
