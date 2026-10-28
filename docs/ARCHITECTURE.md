# BudgetRail — Complete Architecture

> Last updated: October 2026
> Version: V1 deployed (V2 specified, not yet deployed to mainnet)

---

## What BudgetRail is

BudgetRail is a non-custodial USDC payment rail for software agents.

A human wallet owner creates a session: they deposit USDC into a smart contract,
name a specific agent wallet that is allowed to spend it, and set limits (max budget,
per-call cap, expiry date). The agent can then pay for API services automatically,
one call at a time, without the owner ever needing to sign individual payments.
The smart contract enforces every rule. No server can override it.

---

## System components

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Arc Blockchain                              │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  BudgetRail.sol  (non-upgradeable EVM contract)               │  │
│  │                                                               │  │
│  │  Storage per session:                                         │  │
│  │    owner A, agent B, provider C, quoteSigner D                │  │
│  │    maxBudget, perPaymentCap, expiresAt, closed                │  │
│  │    totalFunded, totalSpent                                    │  │
│  │                                                               │  │
│  │  Functions:                                                   │  │
│  │    createSession  — Owner A only                              │  │
│  │    fundSession    — Owner A only                              │  │
│  │    pay            — Agent B only, EIP-712 sig required        │  │
│  │    closeSession   — Owner A only                              │  │
│  │    getSession     — anyone, read-only                         │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  USDC ERC-20: 0x3600000000000000000000000000000000000000            │
│  (6 decimals — all amounts in this system use 6-decimal units)      │
└─────────────────────────────────────────────────────────────────────┘
         ▲  payForRequest(sig)                 ▲  RPC reads
         │                                   │
┌────────┴──────────┐          ┌─────────────┴───────────────────────┐
│  Agent B          │          │  Provider API  (Vercel serverless)   │
│  (browser wallet  │          │                                      │
│   or CLI script)  │ POST ──► │  GET  /api/health                   │
│                   │ /quotes  │  POST /api/quotes  — issues quotes   │
│                   │ POST ──► │  POST /api/fulfill — verifies + pays │
│                   │ /fulfill │                                      │
└───────────────────┘          └─────────────────────────────────────┘
                                         ▲
                                         │ same-origin fetch
                         ┌───────────────┴─────────────────┐
                         │  Frontend  (React + Vite)        │
                         │                                  │
                         │  /                Dashboard       │
                         │  /create          New Budget      │
                         │  /sessions/:id    Manage Session  │
                         │  /playground      Pay for a call  │
                         │  /payments        History         │
                         │  /integrations    SDK / API docs  │
                         └──────────────────────────────────┘
```

---

## The 4 permanent roles

Every session records exactly 4 addresses at creation time.
**They are written into the smart contract and can never be changed.**

| Role | Letter | Who it is | What it does |
|------|--------|-----------|--------------|
| Owner | A | The human who creates the session | Deposits USDC, tops up, closes, gets refund |
| Agent | B | A wallet authorized to spend from the session | Submits payment transactions — one per API call |
| Provider payout | C | The service operator's revenue wallet | Receives USDC on every confirmed payment |
| Quote signer | D | A server-side keypair (private key never in browser) | Signs EIP-712 quotes so the contract can verify them |

**Who sets C and D:** The service operator (you, if you are running BudgetRail as a
service). They are pre-filled from environment variables (`VITE_PROVIDER_PAYOUT` for C,
`VITE_QUOTE_SIGNER` for D). The session owner does not choose them — they are the
terms of using the service.

**Why D is separate from C:** If the signing key D is ever compromised, an attacker can
issue fraudulent quotes — but they still cannot redirect payments away from C, because C
is immutable per session. The damage is limited to the remaining session balance.

---

## Contract address and USDC address

| Item | Value |
|------|-------|
| BudgetRail V1 (Arc Testnet) | `0xf6a13df15ad93c2e2968e1d69c53894a923bda21` |
| USDC ERC-20 (Arc Testnet + Mainnet) | `0x3600000000000000000000000000000000000000` |
| USDC decimals | 6 |
| Arc Testnet chain ID | 5042002 |
| Arc Mainnet chain ID | 5042 |

---

## Money flow — every USDC movement explained

```
STEP 1 — Owner A creates and funds the session
  Owner A signs two transactions:
  Tx 1: USDC.approve(BudgetRailContract, initialDeposit)
        → Owner allows the contract to pull USDC from their wallet
  Tx 2: BudgetRail.createSession(agent, provider, quoteSigner, maxBudget,
                                  perPaymentCap, expiresAt, initialDeposit)
        → Contract pulls initialDeposit USDC from Owner A
        → Contract stores it in escrow (contract balance increases)
        → session.totalFunded = initialDeposit

STEP 2 — Agent B requests a quote (no USDC moves yet)
  Agent → POST /api/quotes {sessionId, inputBytes}
  Server checks onchain: session active? agent correct? balance sufficient?
  Server signs EIP-712 quote with private key D
  Returns: {sessionId, amount, nonce, requestId, requestHash, deadline, signature}

STEP 3 — Agent B pays (USDC moves from contract to Provider C)
  Agent → BudgetRail.payForRequest(sessionId, requestId, requestHash, amount, quoteDeadline, sig)
  Contract verifies:
    msg.sender == session.agent (B)           ← agent check
    recover(sig) == session.quoteSigner (D)   ← quote integrity
    amount <= session.perPaymentCap           ← per-call cap
    totalSpent + amount <= totalFunded        ← budget check
    nonce/requestId not used before           ← replay protection
    block.timestamp <= deadline               ← quote not expired
  If all pass: USDC transfer(session.provider C, amount)
               session.totalSpent += amount
               emits PaymentSettled(sessionId, requestId, amount)

STEP 4 — Provider verifies and delivers result
  Server → POST /api/fulfill {sessionId, txHash, input, quote}
  Server independently verifies:
    tx.status == success
    PaymentSettled event from the correct contract
    event.amount == quote.amount
    SHA-256(input) == quote.requestHash (input was not tampered)
    payment block.timestamp <= quote.deadline
    ERC-20 Transfer from contract to provider C with exact amount
  If all pass: delivers analysis result to agent

STEP 5 — Owner A closes session and recovers unspent funds
  Owner → BudgetRail.closeSession(sessionId)
  Contract: USDC transfer(session.owner A, totalFunded - totalSpent)
            session.closed = true
  The portion already paid to C is NOT returned. Those payments are final.
```

---

## All 10 scenarios

### Scenario 1 — Owner creates a session (happy path)

**Who:** `0xD995` (sh555.eth) in Brave browser
**Page:** `/create`

1. Owner connects wallet, sees their address auto-filled as "Connected owner A"
2. Fills in: Agent wallet = `0xC1CF`, Max budget = $1.00, Per-call cap = $0.05, Expiry = 7 days, Initial deposit = $0.50
3. Provider payout C and Quote signer D are pre-filled from service config — owner cannot change them
4. Clicks Confirm — two wallet prompts appear:
   - Prompt 1: Approve $0.50 USDC to the contract
   - Prompt 2: createSession (pulls the $0.50 and registers all 4 roles)
5. Session #22 created. Contract holds $0.50. Owner now sees it on Dashboard.

**Gas paid by:** Owner A
**USDC movement:** Owner A → Contract escrow ($0.50)

---

### Scenario 2 — Agent pays for one API call (core payment flow)

**Who:** `0xC1CF` in Edge InPrivate
**Page:** `/playground?session=22`

1. Agent connects wallet, enters session ID 22 (or opens from shared link)
2. Pastes a document (723 bytes), clicks "Get Quote"
3. Frontend calls `POST /api/quotes` — server checks session onchain, signs quote for $0.05
4. Quote card appears: amount $0.05, valid for 10 minutes
5. Agent clicks "Pay" — wallet prompts once: `BudgetRail.payForRequest(...)`
6. Contract verifies all 6 conditions (see Money Flow Step 3 above)
7. $0.05 transfers from contract → `0x7D76` (Provider C)
8. Frontend calls `POST /api/fulfill` with the tx hash — server verifies independently
9. Analysis result delivered to agent

**Gas paid by:** Agent B (in USDC, Arc native gas = USDC)
**USDC movement:** Contract escrow → Provider C `0x7D76` ($0.05, permanent)

---

### Scenario 3 — Owner tops up an existing session

**Who:** `0xD995` in Brave
**Page:** `/sessions/22`

1. Owner sees Available = $0.45, Top-up headroom = $0.50 (maxBudget $1.00 − funded $0.50)
2. Clicks "Add Funds — up to $0.50 more", enters $0.25
3. Two wallet prompts:
   - Prompt 1: Approve $0.25 USDC to the contract
   - Prompt 2: fundSession(22, $0.25)
4. Available becomes $0.70. Headroom becomes $0.25.

**Only Owner A can do this.** Any other connected wallet sees "only the owner can add funds."
**USDC movement:** Owner A → Contract escrow ($0.25 additional)

---

### Scenario 4 — Owner closes session and gets refund

**Who:** `0xD995` in Brave
**Page:** `/sessions/22`

1. Owner clicks "Close & Refund $0.45"
2. Confirm modal shows exactly how much is refunded and to which address
3. One wallet prompt: `closeSession(22)`
4. Contract sends $0.45 back to Owner A
5. `session.closed = true` — permanent, cannot be reopened
6. Agent can no longer pay. The $0.05 already paid to C is not affected.

**USDC movement:** Contract escrow → Owner A ($0.45 refund)

---

### Scenario 5 — Session expires and owner forgets to close it

**Date:** After expiry timestamp (e.g. November 1, 2026)

1. The session shows "Expired" status on the page
2. **Nothing happens automatically** — the remaining balance stays locked in the contract
3. Agent tries to pay → contract rejects: `block.timestamp > session.expiresAt`
4. Owner MUST call closeSession to recover funds
5. Until owner closes: money sits in contract indefinitely

**Key point:** Expired does NOT mean refunded. The owner must take action.

---

### Scenario 6 — Stranger opens the session URL (viewer)

**Who:** Any wallet not involved in the session, or no wallet connected
**Page:** `/sessions/22`

1. Session data loads (it is public onchain — anyone can read it)
2. Viewer can see: owner, agent, provider, all amounts, expiry
3. "Add Funds" button: not shown (not owner)
4. "Close & Refund" button: shows but says "only the owner (`0xD995`) can close"
5. If they tried to call the contract directly: it would revert with `NotOwner`
6. No wallet connected: same read-only view, wallet connect button in sidebar

**No action possible.** The contract enforces all role checks regardless of the UI.

---

### Scenario 7 — Agent opens their session page

**Who:** `0xC1CF` (Agent B)
**Page:** `/sessions/22`

1. Page detects `connected address == session.agent`
2. Blue banner appears: "You are the authorized agent (wallet B)"
3. Shows available balance ($0.45) and per-call cap ($0.05)
4. "Go to Playground" button links to `/playground?session=22`
5. "Add Funds" and "Close & Refund" are disabled with message: "only owner `0xD995` can do this"

---

### Scenario 8 — Owner tries to pay as agent (wrong role)

**Who:** `0xD995` (Owner A) in Playground with session 22

1. Playground detects `connected address == session.owner` and `!= session.agent`
2. UI guard blocks the payment: "Owner A cannot pay as agent"
3. Even if the UI guard was bypassed and a tx was submitted:
   Contract reverts with `NotAgent` — `msg.sender (0xD995) != session.agent (0xC1CF)`
4. No USDC moves. Gas is lost for the failed tx.

**The contract is the final enforcer.** The UI guard just saves the user gas.

---

### Scenario 9 — Provider C opens the session page (ownership proof)

**Who:** `0x7D76` (Provider C wallet)
**Page:** `/sessions/22`

1. Page detects `connected address == session.provider`
2. "Provider payout C — ownership proof" panel appears
3. Provider clicks "Verify ownership" — signs a message with their wallet
4. Signature recovers to `0x7D76` → displays "Verified"
5. This lets the operator prove to an auditor or enterprise customer that they
   control the wallet receiving funds

**What this panel does NOT do:** No transaction. No USDC. No onchain change.
It is a display-only cryptographic proof for trust/compliance purposes.

**Important:** This panel only appears for the `0x7D76` wallet. When Owner A (`0xD995`)
is connected, this panel is hidden — the owner cannot sign for Provider C's wallet,
and seeing it caused confusing "wrong address" errors.

---

### Scenario 10 — Quote signer key is rotated

**Operator action:** Update `QUOTE_SIGNER_PRIVATE_KEY` in Vercel env + redeploy

1. All NEW sessions created after the rotation store the new public address in `session.quoteSigner`
2. All EXISTING sessions (like #22) still store the old signer address — this is permanent and immutable
3. The provider server now signs quotes with the new key
4. When agent tries to pay on an old session: contract rejects — `sig recovers to new key, expected old key`
5. Old session pages show a yellow "Quote signer mismatch" warning banner
6. Fix for users with old sessions: Owner closes → refund → create new session (new session gets new signer)

**This is a breaking change for all active sessions.** Key rotation should only be
done in response to a security incident, not routinely. Plan and notify users first.

---

## Page-by-page guide

### `/` — Dashboard

Shows two sections based on the connected wallet:
- **My Budgets:** Sessions where `session.owner == connected wallet`. Shows all your funded sessions.
- **Agent Sessions:** Sessions where `session.agent == connected wallet`. These are sessions owned by someone else who authorized your wallet to pay from them.
- **View by session ID:** Enter any session ID to navigate directly — useful for sharing session links.

### `/create` — New Budget

Creates a new session. The connected wallet becomes Owner A permanently.
- Owner A address is displayed at the top and cannot be changed
- Agent wallet B: the wallet you authorize to make payments on your behalf
- Provider C and Quote signer D: auto-filled from service config (not user-chosen)
- Two transactions required: ERC-20 approve + createSession

### `/sessions/:id` — Manage Session

Shows full session state. Actions depend on which wallet is connected:

| Connected wallet | What they see |
|-----------------|---------------|
| Owner A | Add Funds button, Close & Refund button |
| Agent B | Blue agent banner, Go to Playground button |
| Provider C | Ownership Proof panel only |
| Anyone else / unconnected | Read-only view of all session data |

### `/playground` — Pay for an API call

The agent's payment interface. Pre-fills session ID from `?session=N` URL param.
- Connect wallet B, enter session ID, paste document
- Click "Get Quote" → server issues signed quote
- Click "Pay" → one transaction to the contract
- Server verifies payment onchain → delivers result

### `/payments` — Payment History

Scans `PaymentSettled` events from the contract starting from the deploy block.
Shows all payments made from sessions owned by or where the connected wallet is agent.

---

## EIP-712 quote structure

Every payment requires a server-signed quote. The quote proves the server authorized
the exact amount for the exact input.

```
domain:
  name:              "BudgetRail"
  version:           "1"
  chainId:           5042002 (testnet) or 5042 (mainnet)
  verifyingContract: <BudgetRail contract address>

type PaymentQuote:
  uint256 sessionId    — which session
  bytes32 requestId    — unique ID for this call (prevents replay)
  bytes32 requestHash  — SHA-256(input bytes) — binds quote to exact input
  uint256 amount       — USDC amount in 6-decimal units
  uint64  quoteDeadline — unix timestamp after which quote is invalid
```

The contract recovers the signer address from this structure and checks it against
`session.quoteSigner`. A quote for a different input, different amount, different
session, or signed by a different key is rejected.

---

## Off-chain fulfillment verification (8 independent checks)

`POST /api/fulfill` never trusts the client. It independently verifies all of these
before returning any result:

1. `SHA-256(input) == quote.requestHash` — input not tampered between quote and payment
2. EIP-712 signature valid against `session.quoteSigner` from the live contract
3. `tx.status == 1` (transaction succeeded onchain)
4. `tx.to == BudgetRail contract address` (not a different contract)
5. `PaymentSettled` event emitted from BudgetRail (not a different contract emitting a fake event)
6. `event.sessionId == quote.sessionId` and `event.amount == quote.amount`
7. ERC-20 Transfer from BudgetRail to Provider C with exact amount (confirms real USDC moved)
8. `payment block.timestamp <= quote.deadline` (uses onchain time, not wall clock)

Any single check failing returns 400 or 402 — no result delivered.

---

## Contract security properties

| Property | How it is enforced |
|----------|--------------------|
| Only Agent B can pay | `msg.sender != session.agent → revert NotAgent` |
| Only Owner A can fund/close | `msg.sender != session.owner → revert NotOwner` |
| Provider C is immutable | Set at createSession; no update function exists |
| Quote signer D is immutable | Set at createSession; no update function exists |
| No replay attacks | `_requestPaid[sessionId][requestId]` boolean, set before transfer |
| Budget cap enforced | `newTotalSpent > session.totalFunded → revert FundedBudgetExceeded` |
| Per-payment cap enforced | `amount > session.perPaymentCap → revert PerPaymentCapExceeded` |
| Checks-Effects-Interactions | State updated before every external token call |
| Reentrancy guard | `nonReentrant` on `pay` and `closeSession` |
| Input integrity | SHA-256(input) in every PaymentSettled log, verified by server |
| Expiry enforced | `block.timestamp > session.expiresAt → revert SessionExpired` |

---

## Decimal handling

Arc has ONE USDC pool exposed two ways. They are the same money — not two balances.

| View | Decimals | Used for |
|------|----------|---------|
| ERC-20 | 6 | All session amounts, balances, transfers, display |
| Native gas | 18 | Gas fees only (Arc gas = USDC) |

`1 USDC = 1_000_000 in 6-decimal units = 1_000_000_000_000_000_000 in 18-decimal units`

The contract and all server code use 6-decimal units exclusively.
The frontend converts between display (e.g. "$0.05") and units (50000) without
floating-point arithmetic.

**Never show the native balance AND the ERC-20 balance at the same time** — they
describe the same pool and adding them would double-count.

---

## Infrastructure layout

```
arc-budgetrail.vercel.app
│
├── / → dist/index.html    (React SPA — all routes handled by React Router)
│          vercel.json has a catch-all rewrite so /create, /sessions/22,
│          /playground all serve index.html and React Router takes over.
│
├── /api/rpc               (Vercel serverless function — proxies JSON-RPC to Arc)
├── /api/health            (Vercel serverless function — provider health check)
├── /api/quotes            (Vercel serverless function — issues EIP-712 quotes)
└── /api/fulfill           (Vercel serverless function — verifies payment + delivers result)

Local development:
  Vite dev server (port 5173) — serves the React app
  Provider Bun server (port 3001) — runs provider API
  Vite proxy: /api/* → localhost:3001  (except /api/rpc → Arc RPC directly)
  bun run dev starts both with concurrently
```

---

## Environment variables — who reads what

| Variable | Read by | Purpose |
|----------|---------|---------|
| `VITE_ARC_NETWORK` | Frontend | testnet or mainnet toggle |
| `VITE_BUDGET_RAIL_ADDRESS` | Frontend | V1 contract address |
| `VITE_PROVIDER_PAYOUT` | Frontend | Provider C address (displayed in UI) |
| `VITE_QUOTE_SIGNER` | Frontend | Signer D public address (for mismatch warning) |
| `VITE_PROVIDER_API_URL` | Frontend | Provider API base URL (empty = same-origin Vercel) |
| `VITE_ARC_TESTNET_RPC` | Frontend + /api/rpc | RPC endpoint |
| `VITE_TREASURY_ADDRESS` | Frontend | V2 treasury E address |
| `PROVIDER_NETWORK` | Provider server | testnet or mainnet |
| `PROVIDER_PAYOUT_ADDRESS` | Provider server | Must match VITE_PROVIDER_PAYOUT |
| `QUOTE_SIGNER_PRIVATE_KEY` | Provider server | Signs all quotes — KEEP SECRET |
| `ALLOWED_ORIGIN` | Provider server | CORS — only this origin can call the API |
| `ARC_TESTNET_RPC_URL` | Provider server + /api/rpc | RPC for onchain verification |
| `BUDGET_RAIL_V2_ADDRESS` | Provider server | V2 contract (empty = V2 disabled) |
| `TREASURY_ADDRESS` | Provider server | Must match V2 contract treasury |
| `AGENT_PRIVATE_KEY` | Agent CLI only | Never on any server or in Vercel |

---

## V2 additions (not yet deployed)

V2 adds a 0.5% (50 bps) additive fee on every payment.

```
Payment of $0.05:
  V1: Provider C receives $0.05, Treasury E receives $0.00
  V2: Provider C receives $0.05, Treasury E receives $0.000250 (0.5% of $0.05)
      Agent pays $0.050250 total (additive, not deducted from provider)
```

V2 treasury E is baked into the contract constructor as an immutable address.
C and E MUST be different wallets on mainnet (the contract emits a warning event
if they are the same at deploy time, and the preflight script blocks mainnet deployment).

V2 routes: `POST /api/quotes/v2` and `POST /api/fulfill/v2`
V2 frontend: CreateBudget shows fee breakdown when `VITE_BUDGET_RAIL_V2_ADDRESS` is set.

---

## What to change before going to mainnet

1. Generate new wallets for Role C, Role D keypair, and Role E (all three must be fresh)
2. C and E must be different addresses
3. Deploy V1 (and optionally V2) to Arc Mainnet
4. Update all contract address env vars
5. Set `VITE_ARC_NETWORK=mainnet` and `PROVIDER_NETWORK=mainnet`
6. Add `VITE_ARC_MAINNET_RPC=https://rpc.mainnet.arc.io` and `ARC_MAINNET_RPC_URL=https://rpc.mainnet.arc.io`
7. Run `bun run v2:preflight` — must pass with no C=E warning
8. Get an independent security audit of BudgetRail.sol before real money is at risk

See `docs/MAINNET-DEPLOY-RUNBOOK.md` and `docs/GO-NOGO-MATRIX.md` for the full checklist.
