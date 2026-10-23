# BudgetRail — Security Review

> **No third-party audit has been performed. This document records internal analysis only. Do not use in production with material funds without an independent professional audit.**

---

## Threat model

| Actor | Trust level | What they can do |
|-------|-------------|-----------------|
| Owner A | Trusted | Create/fund/close sessions; restricted to own sessions |
| Agent B | Semi-trusted | Call `payForRequest` on sessions where `session.agent == B`; cannot sign quotes |
| Provider D | Semi-trusted | Sign EIP-712 quotes; cannot redirect funds (C is fixed) |
| Provider C | Passive | Receives USDC; no contract permissions |
| Arbitrary caller | Untrusted | Can read public state; cannot modify any session |
| Malicious token | Untrusted | MockERC20 blocklist + ReentrantToken covered in tests |

---

## Security findings by severity

### HIGH

**H1 — Token blocklist can permanently lock funds (design limitation)**
- If Circle's USDC contract blocklists `session.owner`, `closeSession` reverts and the session can never be closed. Funds are not lost (they remain in the contract) but are inaccessible.
- Mitigation: Not fixable without adding an admin escape hatch (which introduces centralization). Documented in contract NatDoc and README. Acceptable for MVP; users should not put material funds in sessions with a blocklisted owner.
- Status: ACKNOWLEDGED, no code change.

**H2 — Quote signer key D compromise enables session drain (within caps)**
- If `QUOTE_SIGNER_PRIVATE_KEY` (key D) is leaked, an attacker can issue valid quotes and drain the funded budget of any session using that key, up to `perPaymentCap` per request (bounded by `maxBudget`).
- Mitigation: Key D is read only from environment variable; never logged, never returned by API, never committed. Rotate the key and update `session.quoteSigner` (requires creating a new session). Use a hardware security module or secrets manager in production.
- Status: ACKNOWLEDGED. Operational — not a contract bug.

**H3 — Treasury E and Provider C share the same address (V2 immutable risk)**
- Both `VITE_TREASURY_ADDRESS` (E) and `VITE_PROVIDER_PAYOUT` (C) are currently set to `0x7D76349B806148594b8075A83b2f8fb12feaA743`. The V2 treasury address is **immutable** in the contract — it cannot be changed after deployment. If V2 is deployed with C=E, fee routing cannot be separated without a new contract deployment.
- **Action required before V2 mainnet deploy:** Confirm whether C=E is intentional (document it), or generate a separate treasury wallet and verify its ownership before deploying BudgetRailV2.sol. A signed-nonce proof of treasury wallet ownership should be recorded in `evidence/mainnet.json`.
- Status: OPEN — operator decision required before V2 deploy.

### MEDIUM

**M1 — Block-timestamp manipulation at expiry boundary**
- `block.timestamp` is controlled by the block proposer with a tolerance of a few seconds. A proposer can include a transaction just before or just after `expiresAt`/`quoteDeadline` by slightly adjusting the block time.
- Mitigation: Use session and quote expiry windows of at least 1 minute; avoid sessions that expire within a 15-second window of the intended cutoff. Documented in contract NatDoc.
- Status: ACKNOWLEDGED, no code change.

**M2 — Rate limiter is in-memory and resets on server restart**
- The per-session quote rate limiter (`provider/src/lib/ratelimit.ts`) uses an in-process Map. On restart, all buckets reset, allowing a burst of requests.
- Mitigation: Replace with a Redis-backed rate limiter for production. Documented in ratelimit.ts.
- Status: KNOWN LIMITATION (MVP), low severity in testnet context.

**M3 — CORS policy is open (`Access-Control-Allow-Origin: *`)**
- The provider API accepts requests from any origin.
- Mitigation: In production, restrict to the known frontend origin. Acceptable for testnet.
- Status: KNOWN LIMITATION (MVP).

### LOW

**L1 — `availableBalance` does not check session expiry**
- `availableBalance` returns the funded-minus-spent balance without checking if the session has expired. Callers could misinterpret an expired session's balance as available.
- Mitigation: Callers should check `session.expiresAt` and `session.closed` independently. The UI and provider code do this.
- Status: ACKNOWLEDGED, by-design (view function, no state change).

**L2 — Unsolicited USDC deposits are permanently locked**
- USDC sent to the contract address outside `fundSession` is credited to no session and is unrecoverable (no fallback/sweep).
- Mitigation: Documented prominently in contract NatDoc and README. Users must use `fundSession` only.
- Status: ACKNOWLEDGED, by-design (no admin sweep is a security feature).

**L3 — `sessionIdsByOwner` does not validate `limit` upper bound**
- A caller can pass a very large `limit` to `sessionIdsByOwner`, causing a large in-memory allocation in the EVM.
- Mitigation: Gas cost constrains the practical limit. The frontend passes a bounded limit (10–50). Not exploitable for state corruption.
- Status: ACKNOWLEDGED.

**L4 — Provider API logs unstructured errors at INFO level**
- Unhandled errors are logged with `console.error`. In production, a structured logger (pino, winston) with log-level filtering should be used to avoid leaking stack traces or request details.
- Status: KNOWN LIMITATION (MVP).

**L5 — `fulfillment` uses `decodeEventLog` with a try/catch returning null**
- If the ABI or log format changes (unlikely for an immutable contract), `decodePaymentSettledLog` returns null and the server returns 400. This is a safe failure mode.
- Status: ACCEPTABLE.

### INFORMATIONAL

**I1 — EIP-712 typehash hard-coded in test matches contract**
- Test SC56 (`test_SC56_viem_eip712Vector`) cross-validates the contract's domain separator and typehash against viem's EIP-712 implementation. This is a regression guard.

**I2 — `uint96` is sufficient for all reasonable budgets**
- Max value: ~79,228,162,514,264,337,593 (≈79 trillion USDC base units = ~$79 trillion). No practical budget can overflow uint96.

**I3 — No `receive()` or `fallback()` — confirmed by SC54**
- The contract does not accept ETH. SC54 confirms a plain ETH send reverts.

**I4 — `_nextSessionId` overflow in `unchecked` block**
- Overflowing `uint256` at 2^256 sessions is computationally impossible. The `unchecked` block is safe.

---

## Invariants verified by testing

Both Foundry invariant suites ran 256 sequences × 128,000 calls with zero reverts:

1. `invariant_totalFundedLeMaxBudget`: `session.totalFunded <= session.maxBudget` always holds.
2. `invariant_totalSpentLeTotalFunded`: `session.totalSpent <= session.totalFunded` always holds.

---

## Pre-deployment checklist

- [ ] All 59 contract tests pass (`forge test`)
- [ ] All 64 provider API tests pass (`cd provider && bun test`)
- [ ] All 15 agent CLI tests pass (`cd agent && bun test src/test/`)
- [ ] Frontend lint and typecheck clean (`bun run check`)
- [ ] No secrets in git history (check with `git log -p | grep -i private_key`)
- [ ] `.env` and `recovery_file*` are in `.gitignore`
- [ ] `QUOTE_SIGNER_PRIVATE_KEY` stored in a secrets manager; never in source
- [ ] `USDC_ADDRESS` constructor arg verified against `onchain-facts.ts` registry
- [ ] Contract bytecode matches local artifact (`forge verify-contract` or manual bytecode diff)
- [ ] EIP-712 domain matches: `name="BudgetRail"`, `version="1"`, correct `chainId`, correct `verifyingContract`
- [ ] Independent contract review completed (not this document)
- [ ] Mainnet deployer wallet has sufficient native USDC for gas
- [ ] `PROVIDER_PAYOUT_ADDRESS` and `QUOTE_SIGNER_ADDRESS` are distinct addresses
- [ ] Rate limiter replaced with persistent store (Redis) before production load

---

## Disclosure policy

This project is a solo hackathon/microgrant submission. There is no formal bug bounty. To report a security issue, contact the project author directly via the GitHub repository.
