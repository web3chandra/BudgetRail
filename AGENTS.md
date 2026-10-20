# BudgetRail

> Built with Arc Studio - programmable USDC payment-session vault for software agents on Arc.

This is the **project memory** — what Arc Studio remembers about building this app. It helps future agents (or humans) understand and extend the project.

---

## What This App Does

BudgetRail is a full-stack programmable USDC payment-session vault for software agents on Arc. An Owner (A) creates a session bounded by one authorized Agent (B), a fixed Provider payout wallet (C), a separate quote Signer (D), a max total USDC budget, per-payment cap, and expiry. The Provider serves a fixed-price Document Insights API, issuing a signed EIP-712 invoice. The Agent pays through the smart contract; the Provider verifies real onchain settlement before returning a response. The Owner can close the session and reclaim unspent USDC at any time.

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity ^0.8.24 (compiled 0.8.28, EVM Paris) + Foundry
- Provider API: Node.js / TypeScript (Express)
- Agent CLI: Node.js / TypeScript (local operator)
- Wallet: injected (MetaMask, etc.)
- Chain: Arc Testnet (Chain ID: 5042002) / Arc Mainnet (Chain ID: 5042)
- Token: USDC ERC-20 (6 decimals) — Address: 0x3600000000000000000000000000000000000000 (same on testnet and mainnet)
- Native gas: USDC at 18 decimals (same pool, different view — not a second token)
- Toasts: Sonner

## Key Files

- `contracts/BudgetRail.sol` — Main smart contract (Part 2 complete)
- `contracts/out/BudgetRail.sol/BudgetRail.json` — Compiled artifact + ABI
- `contracts/test/BudgetRail.t.sol` — Full Foundry test suite (57 functional + 2 invariant = 59 tests, all pass)
- `docs/BudgetRail-contract.md` — Full contract technical reference
- `docs/arc-studio-provenance.md` — Deployment provenance: addresses, tx hashes, test results
- `evidence/testnet.json` — Real onchain deploy data + lifecycle checklist
- `src/App.tsx` — Frontend entry point (Part 7)
- `provider/` — Provider API server (Bun/TypeScript) — health, quotes, fulfill
- `provider/src/lib/config.ts` — Provider config (env vars)
- `provider/src/lib/eip712.ts` — EIP-712 quote signing
- `provider/src/lib/insights.ts` — Document Insights v1 (deterministic text analysis)
- `provider/src/lib/onchain.ts` — Read-only viem public client + log decoders
- `provider/src/routes/health.ts` — GET /api/health
- `provider/src/routes/quotes.ts` — POST /api/quotes
- `provider/src/routes/fulfill.ts` — POST /api/fulfill
- `provider/test/` — 64 provider unit tests (all pass): insights.test.ts, eip712.test.ts, quotes.test.ts, fulfill.test.ts
- `agent/` — Agent CLI (Part 9)

## Deployed Contracts

| Network | Address | Tx | Deployed |
|---------|---------|-----|---------|
| Arc Testnet | `0xf6a13df15ad93c2e2968e1d69c53894a923bda21` | `0xf33cb9096a45c5cc083fbee4366384f4257f509ab94fe46ec4291e775bc4a5d9` | 2026-10-16T18:01:47.925Z |

Explorer: https://explorer.testnet.arc.io/address/0xf6a13df15ad93c2e2968e1d69c53894a923bda21
Constructor arg: `0x3600000000000000000000000000000000000000` (Arc USDC ERC-20)
Verified onchain: `USDC_ADDRESS()` = `0x3600000000000000000000000000000000000000`, `decimals()` = 6

## Build Progress

| Part | Description | Status |
|------|-------------|--------|
| 1 | Architecture design & threat model | Complete |
| 2 | BudgetRail.sol + ABI + documentation | Complete |
| 3 | Contract tests (Foundry) — 59/59 pass | Complete |
| 4 | Contract deploy to Arc Testnet | Complete — `0xf6a13df15ad93c2e2968e1d69c53894a923bda21` |
| 5 | Provider API (Bun/TypeScript) — health, quotes | Complete |
| 6 | Provider fulfill with receipt verification — 64/64 tests pass | Complete |
| 7 | Frontend (React/wagmi) | Pending |
| 8 | Frontend tests | Pending |
| 9 | Agent CLI | Pending |
| 10 | End-to-end smoke test | Pending |

## Contract: BudgetRail

### Session struct
```
owner         address — Owner A
agent         address — Authorized agent B
provider      address — Payout wallet C
quoteSigner   address — EIP-712 quote signer D
maxBudget     uint96  — Max total USDC (6-dec)
perPaymentCap uint96  — Max per payForRequest call
totalFunded   uint96  — Cumulative deposits
totalSpent    uint96  — Cumulative payments
expiresAt     uint64  — Unix expiry timestamp
closed        bool    — Permanent close flag
```

### EIP-712 PaymentQuote
```
name: "BudgetRail", version: "1", chainId: runtime, verifyingContract: deployed address
PaymentQuote(uint256 sessionId, bytes32 requestId, bytes32 requestHash, uint256 amount, uint64 quoteDeadline)
```

### Key Custom Errors
ZeroAddress, InvalidBudget, InvalidPerPaymentCap, ExpiryInPast, SessionNotFound,
NotOwner, NotAgent, SessionAlreadyClosed, SessionExpired, ZeroAmount,
BudgetExceeded, FundedBudgetExceeded, LifetimeBudgetExceeded, PerPaymentCapExceeded,
QuoteExpired, QuoteDeadlineExceedsSession, RequestAlreadyPaid, InvalidSignature

## To Run

```bash
bun install
bun run dev
```

## To Build Contracts

```bash
bun run contracts:build   # forge build
bun run contracts:test    # forge test
```
