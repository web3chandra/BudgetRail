# BudgetRail

**Programmable USDC payment-session vault for software agents on Arc.**

Built with [Arc Studio](https://studio.arc.io) — source, tests, and all deployments originate in the same Studio project.

---

## What it solves

Software agents need to pay API providers per-call in USDC, but:
- A human owner wants a hard budget cap, per-call spending limit, and a refund path.
- The provider wants guaranteed, non-repudiable, quota-free settlement.
- The agent should not hold a blank approval or an unbounded USDC allowance.

BudgetRail solves this with a session-based smart contract vault:

1. **Owner A** creates a session: specifies agent B, provider wallet C, quote signer D, max budget, per-payment cap, and expiry.
2. **Owner A** funds the session with exactly the approved USDC amount (bounded by `maxBudget`).
3. **Provider D** issues signed EIP-712 quotes to agent B; each quote binds a `requestHash = SHA-256(input)`, a `requestId`, an `amount`, and a `quoteDeadline`.
4. **Agent B** calls `payForRequest` on-chain — the contract verifies the signature, deducts spent budget, and transfers USDC to provider C. No USDC leaves the contract to any other address.
5. **Provider API** serves results **only** after independent on-chain verification of the `PaymentSettled` event and the ERC-20 `Transfer` log.
6. **Owner A** can close the session at any time (including after expiry) to recover unspent USDC.

## How it differs

| Property | Typical pay-per-call API | BudgetRail |
|----------|--------------------------|------------|
| Payment proof | Server-side trust | On-chain EIP-712 receipt |
| Budget enforcement | Advisory / soft | `maxBudget` + `perPaymentCap` enforced in contract |
| Refund path | Manual / none | `closeSession` always refundable |
| Provider address | Configurable per-call | Immutable per session |
| Replay protection | API key / nonce | `requestId` stored on-chain |
| Input integrity | None | `requestHash = SHA-256(input)` bound in signature |
| Agent isolation | None | Only authorized `agent` B address can pay |

## Known risks and limitations

- **Block-timestamp manipulation**: quote/session expiry uses `block.timestamp`; proposer drift of a few seconds can affect boundary cases. Use generous expiry windows (>1 minute).
- **Token blocklist**: if Circle blocklists the owner or provider address, `closeSession`/`payForRequest` will revert. No admin override exists in this MVP.
- **Unsolicited USDC deposits**: USDC sent directly to the contract outside `fundSession` is permanently locked. Always fund through `fundSession`.
- **Provider key D**: the quote signer private key must be protected on the server. If compromised, an attacker can issue quotes that drain a funded session (budget is still bounded by contract caps).
- **Rate limiter is in-memory**: the provider's per-session rate limiter resets on server restart. A persistent store (Redis) is recommended for production.
- **No independent security audit**: this MVP has not been audited by a third-party security firm. The contracts carry internal invariant tests and adversarial coverage but no external review.
- **Testnet-only deploy**: the mainnet deployment requires the operator to independently deploy, configure, and verify the contract.

## Arc Studio project

> Studio Project URL: (insert your Arc Studio project URL after export)

All source, tests, and the testnet deployment were produced in the Arc Studio workspace. The exported GitHub repository is traceable to this Studio project via `docs/arc-studio-provenance.md`.

---

## Quick start

### Prerequisites

- [Bun](https://bun.sh) >= 1.3
- [Foundry](https://book.getfoundry.sh) (`forge`, `cast`)
- Node 18+ (for Circle CLI, optional)
- A MetaMask (or compatible) browser wallet
- Arc Testnet USDC (use the "Get test USDC" button in Arc Studio, or the faucet at https://faucet.circle.com)

### 1. Install dependencies

```bash
bun install
cd provider && bun install && cd ..
cd agent && bun install && cd ..
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — see .env.example for required values
```

### 3. Build and test contracts

```bash
bun run contracts:build   # forge build
bun run contracts:test    # forge test --match-path contracts/test/ -v
```

### 4. Run frontend

```bash
bun run dev
# Open http://localhost:5173
```

### 5. Run provider API

```bash
# Set env vars (see .env.example for names)
QUOTE_SIGNER_PRIVATE_KEY=0x... \
PROVIDER_PAYOUT_ADDRESS=0x... \
PROVIDER_NETWORK=testnet \
bun run provider/src/index.ts
# API: http://localhost:3001
```

### 6. Run agent CLI demo

```bash
AGENT_PRIVATE_KEY=0x... \
PROVIDER_API_URL=http://localhost:3001 \
BUDGET_RAIL_ADDRESS=0xf6a13df15ad93c2e2968e1d69c53894a923bda21 \
bun run agent:demo -- --session 1 --text "Hello world"
```

---

## Commands reference

| Command | What it does |
|---------|-------------|
| `bun install` | Install all frontend/scripts deps |
| `bun run dev` | Start Vite dev server (port 5173) |
| `bun run check` | Lint + typecheck frontend |
| `bun run contracts:build` | `forge build` |
| `bun run contracts:test` | `forge test` (59 tests) |
| `cd provider && bun test` | 64 provider API unit tests |
| `cd agent && bun test src/test/` | 15 agent CLI unit tests |
| `bun run agent:demo` | Run agent CLI demo (requires env) |

---

## Repo structure

```
contracts/          Solidity source + Foundry tests + scripts
  BudgetRail.sol      Main contract
  test/               Foundry test suite (SC01–SC57 + 2 invariants)
  script/             Deploy helpers
  out/                Compiled artifacts (gitignored after export)
provider/           Provider API server (Bun/TypeScript)
  src/lib/            Config, EIP-712, onchain reads, rate limiter
  src/routes/         health, quotes, fulfill
  test/               64 unit tests
agent/              Agent CLI (Bun/TypeScript)
  src/lib/            Chain reads/writes, EIP-712 verify, config
  src/demo.ts         Full demo script
  src/test/           15 unit tests
  samples/            Sample input documents
src/                React frontend (Vite + wagmi + ConnectKit)
  pages/              Dashboard, CreateBudget, Playground, PaymentHistory, ManageSession
  components/         Shared components
  lib/                ABI, formatting, error parsing
docs/               Project documentation
  ARCHITECTURE.md
  SECURITY.md
  API.md
  TEST-REPORT.md
  DEPLOYMENT.md
  DEMO-SCRIPT.md
  arc-studio-provenance.md
  BudgetRail-contract.md
evidence/           On-chain evidence (no fabricated data)
  testnet.json        Testnet deployment facts
  mainnet.json        Mainnet evidence (placeholder — populate after mainnet deploy)
.github/workflows/  CI pipeline (ci.yml)
.env.example        Environment variable documentation
```

---

## Tester instructions

### Testnet quick test

1. Open the app at the dev server or hosted URL.
2. Connect a wallet funded with Arc Testnet USDC (use "Get test USDC" in the sidebar).
3. Go to **Create Budget** → enter agent address (can be the same wallet for testing), expiry, budget, and cap → submit.
4. After session is created and funded, go to **Playground** → enter the session ID → paste any text → Request Quote.
5. Switch to the agent wallet (or same wallet if you used same address) → click Pay.
6. After payment confirms, the API fulfillment step runs automatically and shows the Document Insights result.
7. Go to **Manage Session** → Close session to recover unspent USDC.
8. Go to **Payment History** to see all PaymentSettled events on-chain.

### Provider API test

```bash
# Health check
curl http://localhost:3001/api/health

# Request a quote
curl -X POST http://localhost:3001/api/quotes \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"1","service":"document-insights-v1","input":"Hello world"}'

# Fulfill (requires a real txHash from payForRequest)
curl -X POST http://localhost:3001/api/fulfill \
  -H "Content-Type: application/json" \
  -d '{"input":"Hello world","quote":{...},"txHash":"0x..."}'
```

---

## Microgrant submission

This project was built for the Arc Microgrant programme. See `docs/arc-studio-provenance.md` for full provenance.

- **Studio Project URL**: (insert after export)
- **Live app URL**: (insert after deploy)
- **GitHub repo**: (insert after push)
- **Mainnet contract**: (insert after mainnet deploy — see `evidence/mainnet.json`)
- **Builder profile**: (insert your GitHub/X/Farcaster handle)
