# BudgetRail — Deep Improvement Analysis
> Written October 2026. Based on full source read of all 7 layers.
> No fabricated findings. Every item traces to actual code.

---

## 1. What is genuinely working right now

| Layer | Status | Evidence |
|---|---|---|
| BudgetRail.sol on Arc Testnet | Deployed, verified by eth_call | address 0xf6a13df15...bda21, sessions 1-8 confirmed |
| Session create / fund / close | Works | multiple sessions funded onchain |
| payForRequest (same-wallet) | Works | tx confirmed, PaymentSettled emitted |
| payForRequest (separate agent) | Works | tx confirmed |
| Provider /api/health | Works | returns chain, signer, RPC ok |
| Provider /api/quotes | Works | after VITE_PROVIDER_API_URL fix |
| Provider /api/fulfill | Works | after topic0 fix (0xeb67 → 0x5c25) |
| Frontend Playground | Works | all state in useEffect, recovery, retry |
| ManageSession top-up | Works | approve + fundSession, bigint math |
| ManageSession close | Works | all effects in useEffect |
| SDK package | Built | 8 public functions, typed errors |
| Test suite | 208 pass, 0 fail | provider + frontend + agent + SDK |

---

## 2. Confirmed remaining gaps (honest, not speculative)

### Gap 1 — No session with the current quote signer exists yet (blocking)
**Why it matters:** The private key generated in a previous session was ephemeral and is gone. Sessions 1-8 all have `quoteSigner = 0x1b20af...` which no longer matches the running provider's key. A new session must be created using the current `VITE_QUOTE_SIGNER` value before any end-to-end demo works.
**Fix:** Create one new session in the UI (New Budget). The current signer address is visible in the provider info panel.

### Gap 2 — Provider private key is ephemeral (architectural risk)
**Why it matters:** The key lives only in sandbox `.env` / `provider/.env`. When the sandbox pauses and resumes, processes restart but `.env` is preserved — so the key survives restarts. But if Arc Studio resets the sandbox environment or the user starts a new session, the key is gone again and all existing sessions become permanently unusable.
**Fix:** Write the key to `provider/.env` durably and document the backup procedure. Better long-term: accept the key as a startup argument or from a secrets manager, not generated at runtime.

### Gap 3 — Dashboard "Recent Payments" scans only last 1,000 blocks
**Why it matters:** At Arc's block rate, 1,000 blocks ≈ 5 minutes. Payments older than ~5 minutes won't show here even though they're onchain and visible in PaymentHistory.
**Fix:** Use `DEPLOY_BLOCK_TESTNET` as the lower bound, with the same windowed/paginated scan that PaymentHistory uses.

### Gap 4 — Session ID input in Playground uses `type="number"`
**Why it matters:** The same mouse-wheel bug that caused session #3 to show $14.27 can affect the session ID input — a wheel scroll could change a 5 to a 4 or 6 silently.
**Fix:** Change to `type="text" inputMode="numeric"` with a numeric-only pattern, exactly as was done for money inputs.

### Gap 5 — No expiry warning before a session expires
**Why it matters:** If you create a session with a 7-day expiry and then come back in 8 days, the USDC is locked until you close. There's no reminder anywhere.
**Fix:** Add an "Expiring soon" warning in both Dashboard and ManageSession when `expiresAt - now < 24h`. Already tracked as a stat in Dashboard but not surfaced as a warning.

### Gap 6 — USDC balance display note is confusing
In Dashboard, the note says "native USDC gas balance is separate (18 dec, same pool, not summed here)". This is technically correct but will confuse every user. Arc's design is that native and ERC-20 are THE SAME POOL — the note should say that clearly.
**Fix:** Reword to "Your USDC balance (ERC-20 view, 6 decimals). On Arc, this is the same USDC used for gas."

### Gap 7 — RepoCheck is designed but not connected to the provider
**Why it matters:** `examples/provider-api/repocheck.ts` implements the full RepoCheck logic (GitHub API + OSV) but it's not wired into `provider/src/routes/fulfill.ts` or `provider/src/routes/quotes.ts`. The service registry lists it, but the provider will return an error if you ask for `repo-check-v1`.
**Fix:** Add a `repo-check-v1` branch in the provider routes. This is the most impactful single improvement for grant potential.

### Gap 8 — Agent CLI demo.ts hasn't been run since key rotation
**Why it matters:** `agent/src/demo.ts` uses `AGENT_PRIVATE_KEY` from env and reads session+provider config. With the old key gone and a new provider key, the agent needs to target a new session. The CLI itself is correct but the ops instructions in README need updating.
**Fix:** Update `agent/README.md` with the new session ID and provider URL instructions.

### Gap 9 — No mainnet transaction evidence
**Why it matters:** 30% of grant scoring is real Arc USDC movement. Testnet proves the mechanism but the grant criteria specifically says "Arc mainnet USDC movement."
**Blocker:** Independent security review required before mainnet. No shortcuts.

### Gap 10 — SDK has no published package.json / npm publication
**Why it matters:** The SDK lives in `packages/sdk/` but has no `package.json`, so it cannot be imported by external projects without copying files.
**Fix:** Add `packages/sdk/package.json` with name `@budgetrail/sdk`, version, exports, and a build step.

---

## 3. Smart contract — what cannot be improved without redeployment

These are architectural constraints of the deployed contract. They are NOT bugs:

| Constraint | Implication | Workaround |
|---|---|---|
| `quoteSigner` is immutable per session | Key rotation = new sessions | Document clearly; UI warns |
| `provider` is immutable per session | Multi-provider = one session per provider | Service registry handles this |
| `maxBudget` is a ceiling, not a deposit | $15 budget ≠ $15 locked | UI already explains this |
| No emergency pause | Contract cannot be paused if exploit found | Mitigated by no admin keys, no sweep |
| No partial refund | Owner gets `totalFunded - totalSpent` at close | By design — prevents gaming |
| `uint96` amounts | Max ≈ $79 trillion USDC | Non-issue in practice |
| No multi-token support | Only the USDC address set at constructor | By design |
| Token blocklist risk | Provider/owner blocklisting causes revert | Documented in contract comments |

---

## 4. Security — honest assessment

### What is well-protected
- Reentrancy: ReentrancyGuard on payForRequest and closeSession
- Checks-effects-interactions: state updated before safeTransfer in all three write functions
- Replay protection: `_requestPaid[sessionId][requestId]` mapping
- Agent authorization: contract enforces `msg.sender == session.agent`
- Budget overflow: `newTotalSpent > totalFunded` and `> maxBudget` checked separately
- EIP-712: proper domain separator with chainId and verifyingContract
- Direct transfer lock: `fundSession`-only crediting documented in NatSpec
- Quote deadline: bound by session expiry (`quoteDeadline <= expiresAt`)

### What is not yet verified externally
- No independent audit. The 59 Foundry tests cover the contract well but are not a substitute.
- The provider server has no rate limiting on /api/quotes — a malicious actor could spam quote requests and drain the signing key's rate budget
- The provider has no authentication on /api/fulfill — anyone with a valid tx hash could claim a result. (This is intentional design — the result is only non-sensitive text analysis — but should be documented.)
- OSV API in RepoCheck has no SLA. If it's down, the report fails. Should have a graceful degradation path.

---

## 5. UX — what would make the demo more convincing

### High impact (20 minutes each)
1. **Live provider health pill** in the Playground header — a green/amber dot showing the provider is reachable before the user types anything. Currently the user only discovers provider issues after clicking the button.
2. **Session selector in Playground** — instead of manually typing a session ID, show a dropdown of the connected wallet's funded, non-expired sessions. Filter out sessions whose `quoteSigner` doesn't match the current provider.
3. **"New session wizard"** — a guided 3-step flow (configure → review → create) that pre-fills the current provider's payout address and quote signer so the user can't accidentally create a session with wrong addresses.
4. **Transaction timeline in Dashboard** — show a mini-timeline per session: Created → Funded → Paid (N times) → Closed. This makes the lifecycle legible at a glance.

### Medium impact (1-2 hours each)
5. **Expiry countdown warning** — amber banner when session expires within 24 hours, red when within 1 hour.
6. **Result download** — a "Download receipt + result as JSON" button in the Playground done state. This gives the user proof they can keep.
7. **Session comparison table** — when the user has multiple sessions, a compact table view sorted by available balance, with a "Pay" quick-link per row.
8. **Gas balance check** — check the agent wallet's native USDC (gas) balance before opening the wallet. If it's below a safe threshold (e.g. 1000 native units), warn before the signature prompt.

---

## 6. Provider — what would make it production-grade

### Currently missing
1. **Rate limiting** on /api/quotes — add a per-IP or per-session rate limit (e.g. 60 requests/minute). Without it, the quote signer can be driven at unlimited rate.
2. **Request ID deduplication** — if the same requestId arrives at /api/fulfill twice, it should return the cached result. Currently it re-verifies and re-processes. The contract already prevents double-payment, but the provider should also be idempotent.
3. **OSV response caching** — RepoCheck calls api.osv.dev for every request. Add a TTL cache (e.g. 1 hour per package batch) to avoid hitting rate limits under load.
4. **GitHub token support** — unauthenticated GitHub API is limited to 60 requests/hour. Add optional `GITHUB_TOKEN` in provider config to raise this to 5,000/hour.
5. **Structured logging** — the provider currently uses `console.log`. Add a lightweight structured logger (e.g. `pino`) so production logs are machine-readable.
6. **Health check liveness probe** — /api/health currently confirms RPC connectivity by reading contract state. It should also confirm the quote signer key is loaded (without exposing it) and the OSV API is reachable.

---

## 7. SDK — what would make it usable

### Currently missing
1. **package.json** — no npm package definition. Cannot be installed with `bun add`.
2. **Build output** — no `dist/` directory. TypeScript sources work in Bun but not in browser-only bundlers without compilation.
3. **`simulatePay` uses `simulateContract` directly on viem** — this is correct but requires the caller to have a viem public client. Consider accepting a pre-built client or a plain RPC URL.
4. **No React hooks package** — the SDK is Node/Bun compatible. A companion `@budgetrail/react` package wrapping the SDK functions as `useReadSession`, `useSubmitPayment` etc. would make React integration trivial.
5. **No event subscription** — the SDK has `scanPaymentSettledEvents` (polling) but no real-time subscription. Adding a `watchPaymentSettled(callback)` using viem's `watchContractEvent` would enable live dashboards.

---

## 8. Testing — what's genuinely missing

### Tests that don't exist yet
1. **End-to-end against a live forked Arc Testnet** (using `anvil --fork-url`) — the current provider tests use a mock RPC. A fork test would use real contract state without spending real USDC.
2. **RepoCheck integration test** — no test exists that calls the actual OSV API or GitHub API, even with a public well-known repo. Should be in `provider/test/repocheck.test.ts`.
3. **ManageSession top-up with a real allowance check** — the current tests verify the bigint math but not the actual allowance-skip path.
4. **SDK `retrieveResultByConfirmedPayment` with a real receipt** — tested with a mock receipt but not against the actual deployed provider.
5. **Browser refresh recovery** — the localStorage recovery path is tested indirectly but there's no test that simulates a hard page reload and confirms the banner appears.

---

## 9. Grant readiness — honest gap analysis

| Criterion | Current state | Gap |
|---|---|---|
| 30% Real Arc USDC movement | Testnet: 2 confirmed payForRequest txs exist. Mainnet: 0. | Need to complete full lifecycle (create → fund → pay → close) on mainnet. Blocked by: independent audit, operator approval. |
| 25% Arc Studio usage | Studio project URL exists. Contract generated in Studio. Tests run in Studio. | Need: Arc Studio share URL in grant application. Recording showing Studio workflow. |
| 25% Working application | Flow works on testnet with same-wallet and separate-agent sessions. Result delivered. | Need: one clean demo recording with no errors. Need: new session matching current signer for demo. |
| 20% Future potential | SDK built. RepoCheck designed. Multi-service architecture documented. | Need: wire RepoCheck into provider. Publish SDK package.json. |

**Minimum required before grant submission:**
1. Create new session with current signer (5 minutes in UI)
2. Run full demo: create → fund → agent pays → result → close (15 minutes)
3. Record a 3-minute walkthrough video
4. Push code to public GitHub (with .env excluded)
5. Update GRANT-EVIDENCE.md with all tx hashes

**Recommended but not blocking:**
6. Wire RepoCheck into provider
7. Add SDK package.json
8. Fix Dashboard scan to use DEPLOY_BLOCK_TESTNET

---

## 10. Ordered improvement priority

| Priority | Item | Time | Impact |
|---|---|---|---|
| P0 — Blocking | Create new session with current signer | 5 min | Unblocks all demo |
| P0 — Blocking | Update GRANT-EVIDENCE.md with real tx hashes | 15 min | Required for grant |
| P1 — High | Wire RepoCheck into provider routes | 2 hours | Grant: future potential |
| P1 — High | Fix Dashboard scan → DEPLOY_BLOCK_TESTNET | 20 min | Shows real payment history |
| P1 — High | Fix session ID input → type="text" | 5 min | Prevents mouse-wheel bug |
| P1 — High | Add SDK package.json | 20 min | Makes SDK installable |
| P1 — High | Session selector dropdown in Playground | 1 hour | Demo reliability |
| P2 — Medium | Live provider health pill in Playground | 30 min | UX polish |
| P2 — Medium | Expiry countdown warning | 30 min | Prevents USDC lock |
| P2 — Medium | Rate limiting on /api/quotes | 1 hour | Security |
| P2 — Medium | Result download as JSON | 30 min | Grant evidence artifact |
| P2 — Medium | GitHub token support in RepoCheck | 30 min | Rate limit protection |
| P3 — Post-grant | Structured logging in provider | 2 hours | Production readiness |
| P3 — Post-grant | React hooks companion package | 4 hours | Developer experience |
| P3 — Post-grant | Anvil fork integration tests | 4 hours | Test completeness |
| P3 — Post-grant | Real-time event subscription in SDK | 2 hours | Live dashboard support |
| P3 — Post-grant | Independent security audit | weeks | Mainnet prerequisite |
| P3 — Post-grant | Mainnet deployment | manual | 30% grant criterion |
