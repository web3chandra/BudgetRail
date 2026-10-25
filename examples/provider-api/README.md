# BudgetRail — Example Provider API (RepoCheck)

**Integration status: Confirmed live** — uses OSV.dev (`https://api.osv.dev`, free, no key) and GitHub Contents API (unauthenticated). The domain `repocheck.dev` is an unrelated third-party website and is NOT used by this code. `repocheck.ts` is a fully self-contained reference implementation.

This directory shows how to build a new provider service that integrates with BudgetRail.

It extends the existing `provider/` server with a second service called **RepoCheck**,
demonstrating the complete provider pattern: signed quote → payment verification → result delivery.

## How a provider works

```
Agent  ──→  POST /api/quotes   ──→  Provider signs EIP-712 quote
Agent  ──→  payForRequest()    ──→  BudgetRail contract (Arc chain)
Agent  ──→  POST /api/fulfill  ──→  Provider verifies PaymentSettled onchain → delivers result
```

Provider responsibilities:
1. Issue signed quotes with correct sessionId, requestId, requestHash, amount, deadline
2. After payment: verify the tx hash includes a PaymentSettled log from BudgetRail
3. Verify the agent, amount, requestHash, and quoteDeadline match the quote
4. Deliver the result only after all verifications pass
5. Support idempotent retry — same txHash always returns the same result (no double charge)

## RepoCheck service

`repocheck.ts` implements a dependency vulnerability scanner:
- Input: `https://github.com/owner/repo@<40-char-sha>`
- Fetches package manifests from the GitHub Contents API at that exact commit
- Queries OSV (osv.dev) for known CVEs — free, no API key needed
- Returns a structured report with findings and severity counts

**This is NOT a comprehensive security audit.** See disclaimer in the report.

## Adding a new service to the existing provider

1. Create a `myservice.ts` file implementing your compute logic
2. Add the service ID to the service registry in `packages/sdk/src/services.ts`
3. Add a handler in `provider/src/routes/quotes.ts` for your service ID
4. Add the compute call in `provider/src/routes/fulfill.ts`
5. Create a new BudgetRail session with your provider's payout address and quote signer
6. Never reuse an existing session for a new provider

## Security requirements

- Quote signer private key: server-side only. Never in VITE_ env vars or frontend bundles.
- Payout wallet: public address, safe to show in UI.
- Verify the exact PaymentSettled log — check contract address, requestId, amount, agent.
- Idempotent fulfillment: cache result keyed by (requestId, txHash) to avoid re-computation.
- Input validation: bound size, validate structure, prevent SSRF.

## Environment variables

```
QUOTE_SIGNER_PRIVATE_KEY=0x...   # Secret — never expose
PROVIDER_PAYOUT_ADDRESS=0x...    # Public — shown in /api/health
PROVIDER_NETWORK=testnet
BUDGET_RAIL_TESTNET_ADDRESS=0xf6a13df15ad93c2e2968e1d69c53894a923bda21
```

## Running the example

```bash
cd provider
bun run src/index.ts
```

Health check:
```bash
curl http://localhost:3001/api/health
```

Request a quote (replace with a real funded session):
```bash
curl -X POST http://localhost:3001/api/quotes \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"9","service":"document-insights-v1","input":"Hello world"}'
```
