# BudgetRail — Demo Script

2–3 minute walkthrough for the Arc Microgrant video submission.

---

## What to show

### Segment 1: Arc Studio project (30–45 seconds)

1. Open Arc Studio and show the BudgetRail project workspace.
2. Open `contracts/BudgetRail.sol` — point out:
   - `payForRequest` with `nonReentrant` and the EIP-712 `ECDSA.recover` call
   - The `PaymentSettled` event that binds `requestHash`, `agent`, `amount`, and `quoteDeadline`
   - The `USDC_TOKEN` immutable — only one token, no admin override
3. Open the Tracing panel — show that the deploy transaction is visible.
4. Run `bun run contracts:test` in the terminal — show 59/59 pass.

### Segment 2: Provider API and session lifecycle (45–60 seconds)

1. Show the terminal running the provider API:
   ```
   bun run provider/src/index.ts
   ```
   Paste the health endpoint response.

2. In the frontend, connect wallet A.
3. Go to **Create Budget**:
   - Agent: wallet B address
   - Budget: 1 USDC, cap: $0.05
   - Expiry: 1 hour
   - Submit — show the wallet confirmation popup
   - After confirmation, show the session ID from the SessionCreated log

4. Approve USDC and fund the session — show two more wallet popups.

### Segment 3: Payment and fulfillment (45–60 seconds)

1. Go to **Playground**:
   - Enter the session ID
   - Paste a short paragraph of text (5–10 sentences)
   - Click "Request quote" — show the signed quote returned (no result yet)
   - Switch wallet to agent B
   - Click "Pay $0.05 USDC" — show the wallet confirmation
   - After the transaction confirms, the page automatically calls `/api/fulfill`
   - Show the Document Insights result: word count, top keywords, readability tier, extractive summary

2. Open the Arc Testnet explorer — paste the payment tx hash:
   - Show the PaymentSettled event with sessionId, requestId, provider
   - Show the ERC-20 Transfer to the provider wallet for 50000 base units

### Segment 4: Close and refund (20–30 seconds)

1. Go to **Manage Session**:
   - Click "Close session" — show wallet confirmation for owner A
   - After confirmation, show the refund amount (950000 units / $0.95)

2. Optionally show **Payment History** — list of PaymentSettled events on-chain.

---

## Key talking points

- **USDC is gas on Arc** — all session amounts are in ERC-20 USDC (6 decimals); the same USDC pays for both gas and sessions.
- **Non-custodial** — the contract never holds funds for longer than the session; owner can always recover unspent USDC.
- **Unforgeable proof** — the provider returns results only after verifying a real on-chain PaymentSettled event from the exact contract address. A fake event, wrong transfer, or altered input all result in rejection.
- **Immutable provider** — the provider payout address is locked at session creation; key compromise of the quote signer (D) cannot redirect USDC to a different wallet.
- **Studio-to-chain traceability** — the project URL, contract address, and all test evidence are in `docs/arc-studio-provenance.md`.

---

## Negative demo (optional, testnet only — saves mainnet gas)

On the testnet:
1. Try to replay a paid `requestId` — transaction reverts with `RequestAlreadyPaid`.
2. Try to pay with the owner wallet (not the agent) — reverts with `NotAgent`.
3. POST /api/fulfill with an altered input — `requestHash does not match SHA-256(input)`.
4. POST /api/fulfill with the quote but no on-chain transaction — `Transaction not found on chain`.
