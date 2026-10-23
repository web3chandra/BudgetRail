# BudgetRail Agent App Example

A self-contained example showing how an **external AI agent application** integrates BudgetRail using the `@budgetrail/sdk` public API.

> **Testnet only.** This example targets Arc Testnet (chain 5042002). No mainnet configuration is present.

> **Not x402 compatible.** BudgetRail uses its own EIP-712 signed quote protocol. This example does not implement or claim HTTP 402 / x402 compatibility.

---

## What this demonstrates

| Step | What happens | Network needed? |
|------|-------------|-----------------|
| Offline fee simulation | `computeV2Fee(base)` — exact bigint V2 math | No |
| Wrong-wallet guard | `BudgetRailError("PROVIDER_MISMATCH")` on address mismatch | No |
| V1 session read | `readSession(config, sessionId)` → full session struct | Yes (RPC) |
| V2 treasury verify | `verifyV2Treasury(config)` — config matches onchain TREASURY | Yes (RPC) |
| V2 history scan | `scanPaymentSettledV2Events(config, { fromBlock })` | Yes (RPC) |
| V2 quote request | `requestQuoteV2(config, { sessionId, service, input })` | Yes (provider) |
| V2 quote verify | `verifyQuoteV2(config, quote, input, sessionId, cap)` | No (local) |
| V2 simulate pay | `simulatePayV2(config, agentAddress, sessionId, quote)` | Yes (RPC) |
| V2 submit payment | `submitPaymentV2(config, signer, sessionId, quote)` | Yes (onchain) |

---

## Role definitions

| Role | Address | What they do |
|------|---------|-------------|
| **A** — Session owner | Your wallet | Creates sessions, deposits USDC, can close/refund |
| **B** — Agent wallet | This app's wallet | Calls `payForRequest` / `payForRequestV2` |
| **C** — Provider payout | `0x7D763...743` | Receives base USDC on each settled call |
| **D** — Quote signer | `0x70cd9...4aC` | Provider backend signs EIP-712 quotes |
| **E** — Treasury (V2 only) | `0x7D763...743` | Receives 0.5% fee; set immutably in V2 contract |

---

## V2 fee math (exact, no floats)

```
feeUnits   = floor(baseUnits * 50 / 10_000)
grossUnits = baseUnits + feeUnits
```

Example: provider charges `$0.05` (50,000 USDC base units):
```
feeUnits   = floor(50_000 * 50 / 10_000) = 250
grossUnits = 50_000 + 250               = 50_250   → $0.050250
```

- **Provider C receives:** `$0.050000`
- **Treasury E receives:** `$0.000250`
- **Session debited:**     `$0.050250`

The `perPaymentCap` check uses `grossUnits`. Set the cap to cover `base + fee`.

---

## Quickstart

### Prerequisites

- [Bun](https://bun.sh/) >= 1.0
- Arc Testnet RPC access (default: `https://rpc.testnet.arc.io`)
- An existing V1 session on Arc Testnet (session ID 1 or create one via the BudgetRail UI)

### Install

```bash
# From the BudgetRail root
cd examples/agent-app
bun install
```

### Simulate (no wallet, no provider needed)

```bash
bun run simulate
```

Output:
```
BudgetRail Agent App Example
Network: Arc Testnet (chain 5042002)
Mode:    SIMULATE (no onchain writes)
V2 deployed: false

=== BudgetRail SDK — Offline Fee Simulation ===
Provider price $0.05:
  Fee breakdown:
    Provider C receives: 0.050000 USDC  [base]
    Treasury E receives: 0.000250 USDC  [fee = floor(base × 50 / 10_000)]
    Session debited:     0.050250 USDC  [gross = base + fee]
    Full display:        $0.050000 + $0.000250 fee = $0.050250 gross

── V2 spec test: base=$0.050000 ──────────────────────────────
  Expected grossUnits: 50250  Got: 50250
  Expected feeUnits:   250    Got: 250
  Result: PASS ✓
```

### With live provider (V2 quote demo)

1. Deploy V2 contract (see root README / docs/DEPLOYMENT.md)
2. Set `VITE_BUDGET_RAIL_V2_ADDRESS=0x...` in the root `.env`
3. Start the provider: `cd provider && bun run dev`
4. Run:

```bash
bun run start
```

### Full onchain flow (requires agent private key)

```bash
AGENT_PRIVATE_KEY=0x... bun run start -- --confirm
```

This calls `simulatePayV2` (preflight check) then prompts before any onchain write.
See `agent/src/demoV2.ts` for the reference CLI with full pre-flight and operator confirmation.

---

## What is mocked vs real

| Component | Status |
|-----------|--------|
| `computeV2Fee` arithmetic | **Real** — pure bigint, matches Solidity exactly |
| `verifyQuoteV2` checks | **Real** — EIP-712 sig recovery, fee math, deadline, cap |
| `readSession` RPC call | **Real** — live Arc Testnet RPC |
| `verifyV2Treasury` | **Real** — reads TREASURY immutable from V2 contract |
| `scanPaymentSettledV2Events` | **Real** — windowed getLogs with retry |
| Quote request | **Requires provider** — provider/src must be running |
| Session ID | **Demo value** (1) — replace with a real session |
| Agent signer for writes | **Not included** — operator supplies `AGENT_PRIVATE_KEY` |
| x402 HTTP 402 protocol | **Not implemented** — BudgetRail uses its own EIP-712 protocol |

---

## SDK import surface used

This app imports only from `@budgetrail/sdk`. It never touches:
- Contract ABI files directly
- `provider/src/` internal code
- Private keys or signing keys

```ts
import {
  readSession, BudgetRailError, IncompleteHistoryError,
  computeV2Fee, requestQuoteV2, verifyQuoteV2,
  simulatePayV2, verifyV2Treasury, scanPaymentSettledV2Events,
} from "@budgetrail/sdk";
```
