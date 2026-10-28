# BudgetRail — Demo Video Storyboard

> Duration target: 2–3 minutes.
> Record AFTER mainnet deployment and lifecycle are complete.
> All amounts and tx hashes shown must be real.
> Do NOT script a fake payment or fabricate a result.

---

## Scene 1 — Introduction (0:00–0:20)

**Screen:** Arc Studio project view or BudgetRail app homepage.

**Narration:**
"BudgetRail is a USDC payment rail for AI agents, built on Arc using Arc Studio.
It lets an Owner fund a session, an Agent pay for API calls per-request using a signed quote,
and the provider receive payment directly — all onchain, trustlessly, with no platform custody."

**Show:** The homepage at `https://arc-budgetrail.vercel.app`, the chain badge ("Arc Mainnet"),
and the USDC balance of the connected Owner wallet.

---

## Scene 2 — Create session (0:20–0:50)

**Screen:** CreateBudget page, wallet A connected.

**Narration:**
"The owner creates a session by specifying their agent's address, the service provider,
and a USDC budget cap. No funds move yet — the session is created in a single transaction."

**Show:**
- Owner A address (public, no private key visible)
- Agent B address entered in the form
- Provider C address labeled "Service provider — configured by operator"
- Max budget: e.g., 0.10 USDC (100000 units)
- Per-payment cap: 0.05025 USDC (50250 units — gross including 0.5% fee)
- Wallet prompt for `createSession(...)` — show gas estimate
- Confirmed tx hash and explorer link (real Arc Mainnet tx)

---

## Scene 3 — Fund the session (0:50–1:10)

**Screen:** ManageSession page.

**Narration:**
"The owner approves USDC and funds the session. These are two separate transactions
if no allowance exists. The USDC moves from the owner's wallet to the BudgetRail contract escrow."

**Show:**
- Current session state: `totalFunded = 0`, `availableBalance = 0`
- USDC.approve tx (if needed) — real tx hash
- fundSession tx — real tx hash, block number
- Updated state: `totalFunded = 100000`, `availableBalance = 100000`

---

## Scene 4 — Agent requests a quote and pays (1:10–1:40)

**Screen:** Playground page or agent CLI, wallet B connected.

**Narration:**
"The agent requests a signed quote from the provider API. The quote is locked to the
exact input document by its SHA-256 hash. The agent signs and submits the payment transaction."

**Show:**
- Quote API response: base 50000, fee 250, gross 50250 (label all three)
- Fee breakdown displayed before signing: "Provider base → C: $0.050000 / Platform fee 0.5% → E: $0.000250 / Total: $0.050250"
- Wallet prompt for `payForRequestV2(...)` — show gas estimate
- Confirmed tx hash — real Arc Mainnet tx

---

## Scene 5 — Onchain verification (1:40–2:00)

**Screen:** Arc Explorer showing the payment transaction.

**Narration:**
"On Arc Mainnet, we can verify the exact USDC transfers in the transaction receipt:
Provider C received the full service price; Treasury E received only the 0.5% additive fee."

**Show:**
- `PaymentSettledV2` event log with `baseAmount=50000`, `feeAmount=250`, `grossAmount=50250`
- Two ERC-20 Transfer logs:
  - Transfer to Provider C: 50000 units
  - Transfer to Treasury E: 250 units
- `session.totalSpent` updated to 50250

---

## Scene 6 — Service result delivered (2:00–2:15)

**Screen:** Playground fulfill response or agent CLI output.

**Narration:**
"After payment is confirmed, the provider delivers the result. A retry returns the same
result without charging again — idempotent by request ID."

**Show:**
- Real fulfill API response (DocumentInsights or similar — real result, not fake)
- Retry response: same result, no new payment

---

## Scene 7 — Owner closes and refunds (2:15–2:30)

**Screen:** ManageSession page, wallet A connected.

**Narration:**
"The owner closes the session. Unused funds — $0.05 in this case — are returned immediately
to their wallet. The 0.5% fee on the one successful payment is not reversed."

**Show:**
- closeSession tx — real Arc Mainnet tx hash
- `SessionClosed` event: refund = 100000 − 50250 = 49750 units
- Owner wallet balance increased by 49750 USDC units
- Session state: closed

---

## Scene 8 — Closing (2:30–2:50)

**Screen:** Dashboard showing session history. Then Arc Studio workspace briefly.

**Narration:**
"BudgetRail: a per-call USDC payment rail for AI agents. Owner funds escrow, agent pays
per request, provider gets paid instantly, unused budget refunds to owner.
Built entirely in Arc Studio on Arc — where USDC is native gas."

**Show:**
- Session history with real on-chain events
- Brief Arc Studio workspace showing contracts/BudgetRailV2.sol and test results

---

## Required before recording

All of the following must be true when you press record:

- [ ] V2 deployed on Arc Mainnet with verified `FEE_BPS=50`, `TREASURY=<E_address>`
- [ ] `evidence/mainnet.json` fully populated with real tx hashes
- [ ] Wallet A is the real owner (owns session), Wallet B is the real agent
- [ ] Provider C and Treasury E are separate, verified addresses
- [ ] Provider API is live at `https://arc-budgetrail.vercel.app/api/health`
- [ ] No private keys, mnemonics, or raw secrets visible at any point in the recording

---

## What NOT to show

- Private keys, seed phrases, or raw `.env` file contents
- Fabricated or simulated transaction hashes
- Testnet transactions labeled as mainnet
- Amounts that do not match the real onchain evidence
- Claims that the 0.5% fee applies to create/fund/close/refund (it does not)
- V1 contract address (`0xf6a...`) labeled as the V2 contract

---

## Version and chain labels (must appear in recording)

Every screen that shows a contract address or transaction must clearly show:
- Network: "Arc Mainnet" (chain ID 5042)
- Contract version: "V2" (for V2 flows) or "V1" (for V1 flows)
- The correct contract address from `evidence/mainnet.json`
