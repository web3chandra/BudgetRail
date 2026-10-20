# BudgetRail V2 — Fee Design Specification

**Status:** DRAFT — design-only. No Solidity has been written. Awaiting approval before Part 06.
**Date:** 2026-10-20
**Author:** Arc Studio (Part 05)
**Scope:** V2 contract design, fee accounting, roles, invariants, threat model, acceptance criteria.

---

## Table of Contents

1. [Business Rule Summary](#1-business-rule-summary)
2. [Roles](#2-roles)
3. [Fee Accounting — Exact Integer Math](#3-fee-accounting--exact-integer-math)
4. [A. Contract Interface Proposal](#a-contract-interface-proposal)
5. [B. EIP-712 Quote Typed-Data Schema](#b-eip-712-quote-typed-data-schema)
6. [C. Events](#c-events)
7. [D. Frontend / Backend / SDK Schema](#d-frontend--backend--sdk-schema)
8. [E. Sequence Diagrams](#e-sequence-diagrams)
9. [F. V1/V2 Compatibility Plan](#f-v1v2-compatibility-plan)
10. [G. Offline Test Matrix](#g-offline-test-matrix)
11. [H. Security Review Gates and Open Issues](#h-security-review-gates-and-open-issues)
12. [Threat Model](#threat-model)
13. [Acceptance Criteria](#acceptance-criteria)

---

## 1. Business Rule Summary

| Property | Value |
|----------|-------|
| Fee rate | Exactly **50 bps (0.5%)** — immutable, not configurable |
| Fee basis | Provider's **base** quote price only |
| Fee rounding | `floor(baseUnits * 50 / 10_000)` — rounds DOWN, never up |
| Gross | `grossUnits = baseUnits + feeUnits` |
| C receives | Exactly `baseUnits` |
| E receives | Exactly `feeUnits` |
| Fee applies to | Successful `payForRequestV2` calls ONLY |
| Fee-free operations | `createSession`, `fundSession`, `closeSession`, `refund`, `approve` (ERC-20 approval), gas |
| Hidden fees | None — zero minimum fee, zero platform fee on deposits/withdrawals |
| Small-base behavior | If `baseUnits < 200`, `feeUnits = 0`; disclosed in UI and quote; no hidden extra |
| Treasury E | Set at V2 deploy, immutable; nonzero; distinct from D |
| Fee rate rotation | Requires new contract deployment; no admin setter |

---

## 2. Roles

| Role | Label | Description | V2 change vs V1 |
|------|-------|-------------|-----------------|
| A | Owner | Browser wallet; creates/funds/closes sessions; receives refunds | Unchanged |
| B | Agent | Authorized caller of `payForRequestV2`; needs gas | Unchanged |
| C | Provider payout | Receives `baseUnits` per settled payment | Unchanged |
| D | Quote signer | Signs EIP-712 V2 quotes; never receives USDC | Domain version `"2"` required |
| E | Platform treasury | Receives `feeUnits` per settled payment | **NEW in V2** |
| V | Contract vault | Holds session balances; routes splits atomically | Extended for two-recipient payout |
| Deployer | — | Pays deploy gas; sets `treasury` address at construction; no special ongoing authority | Sets E once |

### Role constraints (all enforced in contract)

- E must be nonzero at deploy (`require(treasury != address(0))`).
- E should be distinct from D (not enforced in contract — operator responsibility, documented).
- E cannot be changed after deploy without a new V2 contract.
- C is set per-session at creation; E is shared across all V2 sessions.
- B cannot close A's session; A cannot sign quotes as D.

---

## 3. Fee Accounting — Exact Integer Math

### Constants

```
FEE_BPS       = 50          // 0.5%
FEE_DENOMINATOR = 10_000
USDC_DECIMALS = 6
```

### Formulas

```
feeUnits  = (baseUnits * FEE_BPS) / FEE_DENOMINATOR   // integer division = floor
grossUnits = baseUnits + feeUnits
```

**These formulas are identical in:** contract (Solidity), provider (TypeScript), frontend (TypeScript), SDK (TypeScript), agent. Any deviation is a bug.

### Price table

| Base (USD) | baseUnits | feeUnits (floor) | grossUnits | Fee (USD) | Gross (USD) |
|-----------|-----------|-----------------|------------|-----------|-------------|
| $0.000001 | 1 | 0 | 1 | $0.000000 | $0.000001 |
| $0.001 | 1,000 | 5 | 1,005 | $0.000005 | $0.001005 |
| $0.01 | 10,000 | 50 | 10,050 | $0.000050 | $0.010050 |
| $0.05 | 50,000 | 250 | 50,250 | $0.000250 | $0.050250 |
| $0.10 | 100,000 | 500 | 100,500 | $0.000500 | $0.100500 |
| $1.00 | 1,000,000 | 5,000 | 1,005,000 | $0.005000 | $1.005000 |
| $10.00 | 10,000,000 | 50,000 | 10,050,000 | $0.050000 | $10.050000 |
| $100.00 | 100,000,000 | 500,000 | 100,500,000 | $0.500000 | $100.500000 |

### Zero-fee disclosure rule

When `feeUnits == 0` (base < 200 units = $0.0002):
- Quote still proceeds with `fee: 0n` and `gross == base`.
- Provider receives the full base.
- Treasury E receives nothing for this call.
- UI must display: "Platform fee: $0.000000 (rounds to zero at this price)".
- No minimum fee is charged; no extra is added silently.

### Overflow guard

`baseUnits` is `uint256` in the contract. The multiplication `baseUnits * 50` must not overflow. Maximum safe `baseUnits` before overflow: `type(uint256).max / 50` ≈ `2^251`. In practice, `maxBudget` is set by the owner at session creation and the contract should `require(baseUnits <= maxBudget)` before the multiplication. This is sufficient for all realistic USDC amounts.

---

## A. Contract Interface Proposal

```solidity
// SPDX-License-Identifier: MIT
// BudgetRailV2 — interface only, not final Solidity

interface IBudgetRailV2 {

    // ── Immutable config ────────────────────────────────────────────────────

    function USDC()        external view returns (address);   // ERC-20 USDC address
    function FEE_BPS()     external view returns (uint256);   // 50 — constant
    function TREASURY()    external view returns (address);   // E, set at deploy, immutable
    function VERSION()     external view returns (string);    // "2"

    // ── Session lifecycle ───────────────────────────────────────────────────

    function createSession(
        uint256 sessionId,
        address agent,          // B
        address provider,       // C
        address quoteSigner,    // D
        uint256 maxBudget,      // gross cap (includes fee)
        uint256 expiresAt       // unix timestamp
    ) external;

    function fundSession(
        uint256 sessionId,
        uint256 grossAmount     // owner deposits gross; all goes to vault
    ) external;

    function payForRequestV2(
        uint256 sessionId,
        uint256 baseAmount,     // provider's base price, signed by D
        uint256 feeAmount,      // must equal floor(baseAmount*50/10000), verified in contract
        bytes32 requestId,
        uint256 deadline,
        bytes calldata signature
    ) external;

    function closeSession(uint256 sessionId) external;   // owner A only

    // ── Views ───────────────────────────────────────────────────────────────

    function sessions(uint256 sessionId) external view returns (
        address owner,
        address agent,
        address provider,
        address quoteSigner,
        uint256 maxBudget,
        uint256 totalFunded,
        uint256 totalSpent,     // gross spent (base + fee)
        uint256 expiresAt,
        bool    closed
    );

    function availableBalance(uint256 sessionId) external view returns (uint256);
    // = totalFunded - totalSpent
}
```

### Key design decisions

1. **`feeAmount` is passed by caller and verified in contract.** The contract recalculates `floor(baseAmount*50/10000)` and `require`s it equals `feeAmount`. This prevents fee manipulation even if the backend sends wrong fee; the contract is the source of truth.
2. **`grossAmount` for deposits.** `totalSpent` tracks gross (base+fee). `maxBudget` is a gross cap. This makes the "lifetime deposit capacity" invariant (`topUpHeadroom = maxBudget - totalFunded`) consistent regardless of fee.
3. **Atomic two-transfer payout.** Both `safeTransfer(C, baseAmount)` and `safeTransfer(E, feeAmount)` happen in one transaction. If either fails, the entire transaction reverts — no partial payouts.
4. **`feeAmount` may be zero** when `baseAmount < 200`. The contract accepts this; `safeTransfer(E, 0)` is a no-op but still called to keep the code path uniform.
5. **`requestId` uniqueness** is enforced with a `mapping(bytes32 => bool) usedRequests`. Replayed `requestId` reverts.
6. **No admin sweep / no owner-withdraw.** The contract has no function to extract session funds except `closeSession` (which refunds only the session owner).

---

## B. EIP-712 Quote Typed-Data Schema

### Domain

```json
{
  "name":              "BudgetRail",
  "version":           "2",
  "chainId":           <uint256: deployment chain>,
  "verifyingContract": <address: V2 contract address>
}
```

**Critical:** `version: "2"` is incompatible with V1 domain (`version: "1"`). A V1 signature cannot validate against a V2 contract and vice versa — cross-version replay is structurally impossible.

### Type

```
PaymentQuoteV2(
  uint256 sessionId,
  bytes32 requestId,
  uint256 baseAmount,
  uint256 feeAmount,
  uint256 grossAmount,
  uint256 deadline,
  address provider,
  address treasury
)
```

### Field rationale

| Field | Why included |
|-------|-------------|
| `sessionId` | Binds quote to specific session |
| `requestId` | Unique per request; prevents replay |
| `baseAmount` | Provider's price — what C receives |
| `feeAmount` | Platform fee — what E receives; signer commits to this value |
| `grossAmount` | `base + fee`; wallet pays exactly this; UI shows this |
| `deadline` | Quote expiry; contract checks `block.timestamp <= deadline` |
| `provider` | Locks C address into quote; prevents substitution |
| `treasury` | Locks E address into quote; prevents substitution attack |

Including both `provider` and `treasury` in the signed data means a compromised backend cannot redirect funds to a different C or E without invalidating the signature.

### Typed data hash (pseudocode)

```
PAYMENT_QUOTE_V2_TYPEHASH = keccak256(
  "PaymentQuoteV2(uint256 sessionId,bytes32 requestId,uint256 baseAmount,"
  "uint256 feeAmount,uint256 grossAmount,uint256 deadline,"
  "address provider,address treasury)"
)

structHash = keccak256(abi.encode(
  PAYMENT_QUOTE_V2_TYPEHASH,
  sessionId, requestId,
  baseAmount, feeAmount, grossAmount,
  deadline, provider, treasury
))

digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash))
signer = ecrecover(digest, v, r, s)
require(signer == session.quoteSigner)
```

---

## C. Events

```solidity
// Session lifecycle (unchanged from V1 except contract address)
event SessionCreated(
    uint256 indexed sessionId,
    address indexed owner,
    address agent,
    address provider,
    address quoteSigner,
    uint256 maxBudget,
    uint256 expiresAt
);

event SessionFunded(
    uint256 indexed sessionId,
    address indexed funder,
    uint256 grossAmount,
    uint256 totalFunded
);

event SessionClosed(
    uint256 indexed sessionId,
    address indexed owner,
    uint256 refundAmount
);

// V2-specific payment event — includes full split detail
event PaymentSettledV2(
    uint256 indexed sessionId,
    bytes32 indexed requestId,
    address indexed agent,
    address provider,       // C — received baseAmount
    address treasury,       // E — received feeAmount
    uint256 baseAmount,     // provider earnings
    uint256 feeAmount,      // platform fee (may be 0)
    uint256 grossAmount,    // baseAmount + feeAmount
    uint256 remainingBalance
);
```

### Why `PaymentSettledV2` is a separate event

- V1 indexers filter on `PaymentSettled` (V1 ABI). V2 emits `PaymentSettledV2`. They never collide.
- History scanner in `src/lib/historyScanner.ts` must be extended to handle both ABIs independently, keyed by contract address + chain.
- SDK `scanPaymentSettledEvents` must accept a `version` parameter and use the correct event ABI.

---

## D. Frontend / Backend / SDK Schema

### Quote response (provider → frontend/agent)

```typescript
interface QuoteResponseV2 {
  version:      "2";
  sessionId:    string;         // decimal string (uint256)
  requestId:    string;         // 0x hex bytes32
  baseAmount:   string;         // decimal string, bigint-safe
  feeAmount:    string;         // decimal string; floor(base*50/10000)
  grossAmount:  string;         // decimal string; base+fee
  deadline:     number;         // unix timestamp
  provider:     string;         // address of C
  treasury:     string;         // address of E
  signature:    string;         // 0x hex, D's EIP-712 sig
}
```

**All monetary fields are decimal strings, not numbers.** The frontend converts to `bigint` for all math. `Number` is never used for authorization decisions.

### Fee computation (TypeScript, identical to contract)

```typescript
const FEE_BPS = 50n;
const FEE_DENOMINATOR = 10_000n;

export function computeFee(baseUnits: bigint): { feeUnits: bigint; grossUnits: bigint } {
  const feeUnits  = (baseUnits * FEE_BPS) / FEE_DENOMINATOR; // bigint floor
  const grossUnits = baseUnits + feeUnits;
  return { feeUnits, grossUnits };
}
```

### Quote display (frontend component requirement)

Before the owner/agent approves payment:

```
Service charge (provider):   $0.050000   (50,000 units)
Platform fee (0.5%):         $0.000250   (250 units)
────────────────────────────────────────
You pay (gross):             $0.050250   (50,250 units)

Provider receives:  $0.050000  →  0x7D76...A743
Treasury receives:  $0.000250  →  0x70cd...4C
```

This display is mandatory before any `payForRequestV2` signature is requested.

### SDK `scanPaymentSettledEventsV2` return type

```typescript
interface PaymentSettledV2Event {
  version:          "V2";
  sessionId:        bigint;
  requestId:        string;    // bytes32 hex
  agent:            string;
  provider:         string;
  treasury:         string;
  baseAmount:       bigint;
  feeAmount:        bigint;
  grossAmount:      bigint;
  remainingBalance: bigint;
  blockNumber:      bigint;
  txHash:           string;
  logIndex:         number;
  chainId:          number;
  contractAddress:  string;
}
```

### Provider backend `/api/quotes` V2 request/response diff

Request adds: no new fields (sessionId, inputText, model same).
Response adds: `version`, `feeAmount`, `grossAmount`, `treasury` (E address from env).
Backend computes fee using `computeFee(baseUnits)` — never trusts a client-supplied fee.

---

## E. Sequence Diagrams

### E.1 — Session creation (V2, identical to V1)

```
Owner A                 Frontend              BudgetRailV2            USDC ERC-20
   |                       |                       |                       |
   |-- enter params ------->|                       |                       |
   |                       |-- createSession() ---->|                       |
   |                       |                       |-- emit SessionCreated |
   |<-- confirm session ----|                       |                       |
   |                       |                       |                       |
   |-- enter amount ------->|                       |                       |
   |                       |-- approve(V2, gross) ->|                       |
   |                       |                       |<-- allowance set ------|
   |                       |-- fundSession() ------>|                       |
   |                       |                       |-- transferFrom(A→V) -->|
   |                       |                       |-- emit SessionFunded   |
   |<-- funded confirmed ---|                       |                       |
```

### E.2 — Payment flow V2 (base+fee split)

```
Agent B        Provider API         Frontend/Agent        BudgetRailV2      USDC
   |                |                    |                    |               |
   |-- request ---->|                    |                    |               |
   |                |-- compute fee ---->|                    |               |
   |                |   base=50000       |                    |               |
   |                |   fee=250          |                    |               |
   |                |   gross=50250      |                    |               |
   |                |-- sign EIP-712 --->|                    |               |
   |<-- QuoteV2 ----|                    |                    |               |
   |                |                    |                    |               |
   |-- show preview to owner (base/fee/gross/C/E) ----------->|               |
   |                |                    |                    |               |
   |-- payForRequestV2(sessionId,        |                    |               |
   |     base=50000, fee=250,            |                    |               |
   |     requestId, deadline, sig) ----->|                    |               |
   |                |                    |-- verify fee calc -->|               |
   |                |                    |   require(fee==floor(base*50/10000))|
   |                |                    |-- verify sig ------>|               |
   |                |                    |-- deduct gross ----->|               |
   |                |                    |-- transfer(C, base) >|-->USDC-->C   |
   |                |                    |-- transfer(E, fee) ->|-->USDC-->E   |
   |                |                    |-- emit PaymentSettledV2             |
   |<-- txHash -----|                    |                    |               |
   |                |                    |                    |               |
   |-- POST /api/fulfill (txHash,quote) >|                    |               |
   |<-- result/insights -----------------|                    |               |
```

### E.3 — Failed treasury transfer (revert path)

```
Agent B              BudgetRailV2              USDC ERC-20
   |                      |                        |
   |-- payForRequestV2 -->|                        |
   |                      |-- transfer(C, base) -->|-- success
   |                      |-- transfer(E, fee) --->|-- REVERT (blocklist/balance)
   |                      |<-- revert ---|
   |                      |-- REVERT ALL STATE (C transfer also rolled back)
   |<-- tx reverted -------|
```

Both transfers happen in one transaction. No partial payout is possible.

### E.4 — Close and refund (V2, same as V1)

```
Owner A              BudgetRailV2              USDC ERC-20
   |                      |                        |
   |-- closeSession() --->|                        |
   |                      |-- require(!closed)      |
   |                      |-- require(msg.sender==owner)
   |                      |-- refund = totalFunded - totalSpent
   |                      |-- transfer(A, refund) ->|-- USDC to A
   |                      |-- session.closed = true |
   |                      |-- emit SessionClosed    |
   |<-- confirmed ---------|                        |
```

---

## F. V1/V2 Compatibility Plan

### Core principle: V1 and V2 are completely independent

| Concern | Policy |
|---------|--------|
| V1 sessions | Continue to operate under V1 rules with no changes; no migration |
| V1 funds | Stay in V1 contract vault; never touched by V2 contract |
| V1 users | See no change; V1 UI paths remain fully functional |
| V2 sessions | Created in V2 contract only; cannot reference V1 session IDs |
| Session ID namespace | V1 and V2 share no namespace; a sessionId=5 in V1 and sessionId=5 in V2 are distinct |
| EIP-712 domain | V1 uses `version:"1"`, V2 uses `version:"2"` and different `verifyingContract`; no cross-replay |
| Event indexing | History scanner keys events by `(chainId, contractAddress)`; V1 and V2 events never mix |
| Frontend routing | "Create Budget V2" creates a V2 session; "Create Budget" (V1 legacy) remains available |
| SDK | `scanPaymentSettledEventsV2` is a separate function; existing `scanPaymentSettledEvents` unchanged |

### Migration policy for existing V1 users

- No automatic migration. V1 users must close V1 sessions and create new V2 sessions if they want the V2 fee model.
- V1 `payForRequest` continues to work after V2 is deployed.
- UI shows a banner on V1 sessions: "This is a V1 session. V2 sessions include an itemized 0.5% platform fee."
- No pressure to migrate; V1 is not deprecated at V2 launch.

### Treasury E address bootstrapping

1. Operator generates or selects a wallet for E.
2. Operator verifies ownership of E (signs a message with E's private key, recovers address — never done in Arc Studio chat).
3. Operator sets `VITE_TREASURY_ADDRESS=<E address>` in `.env` and `TREASURY_ADDRESS=<E address>` in `provider/.env`.
4. V2 contract is deployed with E as constructor argument.
5. E address is immutable after deploy.
6. Rotating E requires a new V2 contract deployment and a published migration notice.

---

## G. Offline Test Matrix

### G.1 — Fee arithmetic

| Test | Input | Expected |
|------|-------|----------|
| Standard fee | base=1,000,000 | fee=5,000, gross=1,005,000 |
| Small fee | base=50,000 | fee=250, gross=50,250 |
| Minimum nonzero fee | base=200 | fee=1, gross=201 |
| Zero fee (below threshold) | base=199 | fee=0, gross=199 |
| Zero fee (base=1) | base=1 | fee=0, gross=1 |
| Zero fee (base=0) | base=0 | fee=0, gross=0 |
| Large amount ($100) | base=100,000,000 | fee=500,000, gross=100,500,000 |
| Rounding: not exact multiple | base=333,333 | fee=1,666 (floor), gross=334,999 |
| Overflow guard | base > uint256.max/50 | should revert before multiply |

### G.2 — Contract state invariants

| Invariant | Description |
|-----------|-------------|
| I-1 | `totalSpent <= totalFunded` always |
| I-2 | `totalFunded <= maxBudget` always |
| I-3 | `availableBalance = totalFunded - totalSpent` always |
| I-4 | Each `requestId` used at most once per contract |
| I-5 | USDC balance of vault >= sum of all `availableBalance` across open sessions |
| I-6 | After `payForRequest`, USDC(C) increased by `baseAmount`, USDC(E) increased by `feeAmount` |
| I-7 | After `closeSession`, USDC(A) increased by `availableBalance` at close time |
| I-8 | No function transfers USDC to anyone except C (base), E (fee), A (refund) |
| I-9 | `closed = true` sessions cannot receive funds or payments |
| I-10 | `grossAmount == baseAmount + feeAmount` always verified before state change |

### G.3 — Authorization / access control

| Test | Caller | Expected |
|------|--------|----------|
| payForRequest — wrong agent | owner A, not B | revert `NotAgent` |
| payForRequest — wrong session | B of session 2 | revert |
| closeSession — not owner | B or C | revert `NotOwner` |
| fundSession — closed session | A | revert |
| fundSession — expired session | A | revert |
| payForRequest — expired deadline | B | revert |
| payForRequest — replayed requestId | B | revert `RequestAlreadyUsed` |
| payForRequest — bad signature | B, tampered data | revert `InvalidSignature` |
| payForRequest — wrong fee in sig | B, fee != floor(base*50/10000) | revert `InvalidFeeAmount` |
| createSession — zero provider | A | revert `ZeroAddress` |
| createSession — zero signer | A | revert `ZeroAddress` |
| Direct USDC transfer to contract | anyone | USDC accepted, but inaccessible (no sweep function) — document and monitor |

### G.4 — Top-up and budget caps

| Test | Expected |
|------|----------|
| Top-up within headroom | succeeds |
| Top-up exactly at maxBudget | headroom=0, revert |
| Top-up after partial spend (headroom based on totalFunded not availableBalance) | correct headroom |
| Top-up after close | revert |
| Top-up after expiry | revert |
| grossAmount > availableBalance in payForRequest | revert `InsufficientBalance` |

### G.5 — V1/V2 isolation

| Test | Expected |
|------|----------|
| V1 quote signature rejected by V2 contract | revert (wrong domain) |
| V2 quote signature rejected by V1 contract | revert (wrong domain) |
| V1 session ID used in V2 `payForRequest` | revert (session not found or wrong owner) |
| History scanner V1 events not mixed with V2 events | events keyed separately by contractAddress |

### G.6 — Error and recovery

| Test | Expected |
|------|----------|
| `payForRequest` succeeds but `/api/fulfill` is down | retry with same txHash, no second payment |
| Wallet rejected mid-flow | flow reset, no state change |
| RPC timeout during fee simulation | simulate fails, user sees error, no payment |
| `safeTransfer(E, fee)` reverts (E blocklisted) | entire tx reverts, no partial payout |
| `safeTransfer(C, base)` reverts (C blocklisted) | entire tx reverts |
| Session expires between quote and payment | payment reverts `SessionExpired` |

---

## H. Security Review Gates and Open Issues

### H.1 — Pre-deployment security gates (all must pass before V2 launch)

- [ ] **G1** Independent Solidity audit of V2 contract (minimum: fee calculation, reentrancy, access control, EIP-712 domain, requestId uniqueness, overflow).
- [ ] **G2** Slither static analysis: zero high-severity findings.
- [ ] **G3** Foundry test suite: 100% of invariants in G.2 verified with forge test.
- [ ] **G4** Treasury E address ownership verified by operator before deploy (sign+recover, not just stated).
- [ ] **G5** E is distinct from D (documented; operator-verified before deploy).
- [ ] **G6** Frontend fee display reviewed by a non-technical tester: base/fee/gross all visible before signing.
- [ ] **G7** Cross-version replay test: V1 sig cannot be replayed on V2 and vice versa (automated test).
- [ ] **G8** Provider backend: `computeFee` output verified to match contract for 1,000 random base values (fuzz test).
- [ ] **G9** Testnet lifecycle executed end-to-end with fee split verified onchain (PaymentSettledV2 event decoded).
- [ ] **G10** `evidence/testnet.json` lifecycle fields all populated before mainnet consideration.

### H.2 — Open issues (must resolve before Part 06 implementation)

| ID | Issue | Resolution needed |
|----|-------|------------------|
| OI-1 | Treasury E address: operator has not yet confirmed which wallet this will be | Operator must select, verify ownership, and confirm address before contract is written |
| OI-2 | `payForRequestV2` — should `feeAmount` be passed by caller or computed purely in contract? | Recommendation: compute in contract from `baseAmount` only (remove `feeAmount` param); quote still includes fee for display but contract ignores the caller-supplied value. This eliminates one class of mismatch bug. Decision needed. |
| OI-3 | Session ID generation: V1 uses contract-internal counter or frontend-supplied? V2 must clarify | Recommend contract-internal auto-increment to avoid ID collision across frontend clients |
| OI-4 | Gas cost of two ERC-20 transfers vs one: acceptable on Arc Testnet? | Measure on testnet before mainnet |
| OI-5 | Direct USDC transfer to contract address: funds are permanently stuck (no sweep). Accept or add a recovery path restricted to owner-only? | Policy decision before deploy |
| OI-6 | USDC `safeTransfer` vs `transfer`: USDC on Arc does not return false, but `safeTransfer` is best practice | Use OpenZeppelin SafeERC20 |
| OI-7 | `quoteSigner` stored per-session in V1; same in V2. When D is rotated, old sessions cannot be serviced. Runbook must be published | Already documented in UI (Part 03); confirm V2 contract handles this identically |

### H.3 — Known non-issues (documented for reviewers)

- **No reentrancy risk from USDC transfers:** USDC on Arc is a trusted Circle contract with no hooks. State is updated before transfers (checks-effects-interactions). Nevertheless, add `nonReentrant` modifier as defense-in-depth.
- **Fee rounding down never harms user:** fee is always <= 0.5% of base. Rounding down means E receives slightly less than exactly 0.5% on non-round amounts. This is disclosed and acceptable.
- **Zero fee on micro-payments:** disclosed in UI and quote. No hidden charges.
- **Deployer has no special authority:** constructor sets `treasury` then deployer has no further privilege. Confirmed: no `onlyOwner` admin functions.

---

## Threat Model

| Threat | Attack | Mitigation |
|--------|--------|------------|
| T-1 Compromised D | Attacker signs fraudulent quotes | Quote bound to `sessionId`, `provider`, `treasury`, `deadline`; can only drain session balance up to `availableBalance`; session owner can close immediately |
| T-2 Wrong payout C | Attacker substitutes different C address | C locked in session at creation; `provider` field in EIP-712 quote must match `session.provider`; contract verifies |
| T-3 Wrong treasury E | Attacker substitutes different E address | `treasury` field in EIP-712 quote must match `TREASURY()` (immutable contract constant); contract verifies |
| T-4 Quote tampering | Frontend alters `baseAmount`/`feeAmount` | EIP-712 signature covers all fields; contract re-derives fee from base; any mismatch reverts |
| T-5 Fee rounding manipulation | Caller inflates `feeAmount` to overpay E | Contract ignores caller-supplied fee; computes independently from `baseAmount` (per OI-2 resolution) |
| T-6 Replay attack | Reuse old quote signature | `requestId` mapping; `deadline` check; different `verifyingContract` per deployment |
| T-7 Cross-version replay | Use V1 sig on V2 | EIP-712 domain `version` and `verifyingContract` differ |
| T-8 Wrong network | Submit V2 tx on different chain | `chainId` in EIP-712 domain; `block.chainid` checked at domain separator construction |
| T-9 Budget cap bypass | Pay more than session allows | `require(grossAmount <= availableBalance)` before any transfer |
| T-10 Token blocklist | C or E address USDC-blocklisted | Entire tx reverts; no partial payout; session funds remain safe |
| T-11 Reentrancy | Malicious C/E re-enters contract | Checks-effects-interactions order; `nonReentrant` modifier |
| T-12 Zero fee dust accumulation | E accumulates tiny fees | Transparent via events; E's owner sweeps with their own wallet; no contract function needed |
| T-13 API down after payment | `/api/fulfill` fails after onchain settlement | Retry with original txHash and quote; contract state already settled; no second payment |
| T-14 Direct USDC transfer to contract | User accidentally sends USDC to contract address | Funds stuck (no sweep); mitigated by prominent UI warning "Do not send USDC directly to the contract address" |
| T-15 Customer hidden cost | Fee not disclosed before signing | Mandatory pre-sign display of base/fee/gross; base+fee+gross all in signed quote |

---

## Acceptance Criteria

Before Part 06 (Solidity implementation) begins, all of the following must be confirmed:

- [ ] **AC-1** This document reviewed and approved by operator/stakeholder.
- [ ] **AC-2** Treasury E address selected and operator-verified (OI-1 resolved).
- [ ] **AC-3** Decision on OI-2 (caller-supplied `feeAmount` vs contract-computed only) made and recorded.
- [ ] **AC-4** Decision on OI-5 (stuck direct USDC transfers) made and recorded.
- [ ] **AC-5** All G.2 invariants confirmed as testable in Foundry.
- [ ] **AC-6** All H.1 security gates acknowledged as pre-deploy requirements.
- [ ] **AC-7** V1 sessions confirmed unaffected by V2 deploy on same chain (different contract address).

---

*End of V2-FEE-SPEC.md — design only, no Solidity written.*
