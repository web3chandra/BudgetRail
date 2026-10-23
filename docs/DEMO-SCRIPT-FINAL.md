# BudgetRail — 2-3 Minute Demo Script

> For screen recording submission to Arc Microgrants.
> Target length: 2:30. Maximum: 3:00. No filler; every second shows something real.
>
> **Before recording:** complete the full testnet lifecycle (Steps 1-6 in GRANT-EVIDENCE.md)
> and, for grant submission, the mainnet lifecycle (Gate 6 in MAINNET-DEPLOY-RUNBOOK.md).
> Never record phantom success states. If a transaction is pending, wait for confirmation.

---

## Pre-recording checklist

- [ ] Arc Studio project open in browser
- [ ] Wallet connected (Arc Testnet for dev recording, Arc Mainnet for grant submission)
- [ ] Provider backend running and `/api/health` returns OK
- [ ] Test USDC available in wallet A (use "Get test USDC" button in Arc Studio sidebar for testnet)
- [ ] Screen recorder capturing browser + terminal side-by-side or browser only
- [ ] Microphone optional — narration adds context but is not required

---

## Scene 1 — Arc Studio Build Evidence (0:00 – 0:30)

**What to show:**
1. Arc Studio project URL in browser address bar (5 seconds)
2. Code panel — scroll through `contracts/BudgetRailV2.sol` briefly (10 seconds)
3. Contracts panel — V1 contract deployed, address visible, ABI functions listed (10 seconds)
4. Tracing panel — one past transaction trace expanded, showing USDC transfer events (5 seconds)

**Narration (if used):**
> "BudgetRail was built entirely in Arc Studio — the smart contract, tests, provider backend,
> and frontend. This is the V2 contract with a 50 basis-point platform fee."

---

## Scene 2 — Create Session and Fund (0:30 – 1:00)

**What to show:**
1. Navigate to **Create Budget** page in the app (5 seconds)
2. Fill in: Agent address B, Provider address C, Quote Signer D, budget $0.10, per-payment cap $0.0503, expiry 24h (10 seconds)
3. Click **Create Session** — wallet pops up, confirm tx (10 seconds)
4. Session created — sessionId visible in UI (5 seconds)
5. Click **Approve USDC** then **Fund Session** — two wallet confirmations (10 seconds)
6. Session balance shows $0.10 funded (5 seconds — wait for confirmation if needed)

**Key things visible:**
- VersionBanner: "Arc Testnet / V2 / 0.5% fee on purchases"
- Session ID, owner address A, agent address B
- Funded balance: 100,250 units ($0.100250)

---

## Scene 3 — Pay for a Real API Call (1:00 – 1:50)

**What to show:**
1. Navigate to **Playground** page (3 seconds)
2. Select the session, type a short input (e.g. "Summarize BudgetRail in one sentence") (5 seconds)
3. Click **Request Quote** — quote panel appears (5 seconds)
4. **Show the fee breakdown clearly** (pause here — this is the key grant evidence):
   - Base: 50,000 units ($0.050000) → Provider C
   - Fee: 250 units ($0.000250) → Treasury E
   - Gross: 50,250 units ($0.050250) — what the session pays
   (10 seconds)
5. Click **Pay** — wallet confirmation (5 seconds)
6. Transaction confirmed — "PaymentSettledV2" event visible in lifecycle stepper (5 seconds)
7. Result appears — real Document Insights output (7 seconds)

**Key things visible:**
- Fee breakdown: three separate rows, no hidden costs
- Transaction hash (real, clickable)
- Provider result delivered only after payment confirmed

---

## Scene 4 — Explorer Proof (1:50 – 2:10)

**What to show:**
1. Click the transaction hash link — Arc explorer opens in new tab (5 seconds)
2. Show the two USDC Transfer logs in the transaction receipt (10 seconds):
   - Transfer 1: contract → Provider C, amount 50,000
   - Transfer 2: contract → Treasury E, amount 250
3. Point to `PaymentSettledV2` event (5 seconds)

**Key things visible:**
- Real explorer URL (`explorer.arc.io` for mainnet, `explorer.testnet.arc.io` for testnet)
- Exact amounts match the fee breakdown shown in Scene 3

---

## Scene 5 — Close Session and Refund (2:10 – 2:30)

**What to show:**
1. Navigate to **Manage Session** page (3 seconds)
2. Show the refund math: funded $0.100250, spent $0.050250, refund = $0.050000 (5 seconds)
3. Click **Close Session** — wallet confirmation (5 seconds)
4. Session closed — refund received by owner A, balance shows $0.00 (7 seconds)

**Key things visible:**
- Exact refund amount matches math (no fee reversed on close)
- Session state: CLOSED
- Owner balance increased by exactly the unspent amount

---

## Optional Scene 6 — Payment History (2:30 – 2:45, if time permits)

**What to show:**
1. Navigate to **Payment History** page
2. Show the PaymentSettledV2 entry: base/fee/gross columns visible
3. Coverage badge shows 100% of session blocks scanned

---

## Post-recording checklist

- [ ] Recording length: 2:00 – 3:00
- [ ] Fee breakdown (base/fee/gross) clearly visible in Scene 3
- [ ] Explorer with two Transfer logs visible in Scene 4
- [ ] No phantom success states (every UI update follows a real confirmed transaction)
- [ ] Network shown matches the evidence type (testnet for dev, mainnet for grant submission)
- [ ] No private keys, `.env` values, or unredacted secrets visible on screen
