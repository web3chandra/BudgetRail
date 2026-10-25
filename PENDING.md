# PENDING — Open Tasks

> Delete an item when done. All completed work is in git history / AGENTS.md.
> Critical path to grant (Nov 1): P0-A → H-02 → H-01 → P0-C → H-03 → M-02 → security review → mainnet → recording → submit

---

## BLOCKING

### P0-A — Rotate QUOTE_SIGNER_PRIVATE_KEY
Generate new keypair on your own machine. Update `QUOTE_SIGNER_PRIVATE_KEY` in `provider/.env` and `VITE_QUOTE_SIGNER` in `.env`. Create next session with new D address.

### P0-C — Execute V1 testnet lifecycle
Run the 6-step lifecycle (createSession, fund, payForRequest, fulfill, close) with your wallet. Fill `evidence/testnet.json → testnetLifecycle` with real tx hashes. See `docs/GRANT-EVIDENCE.md`.

---

## HIGH

### H-01 — Deploy BudgetRailV2 to Arc Testnet
1. Decide H-02 first.
2. `bun run v2:preflight --network testnet`
3. Dry-run: `forge build && bun run deploy:self BudgetRailV2 '[...]' --chain ARC-TESTNET`
4. Request broadcast approval, then deploy.
5. Set `VITE_BUDGET_RAIL_V2_ADDRESS` in `.env` and `v2DeployBlock` in `src/lib/arcProfile.ts`.

### H-02 — Decide C=E before V2 deploy (immutable after)
Option A: Accept C=E for testnet, document it, separate before mainnet.
Option B: Run `bun run generate:treasury --confirm` on your own machine now, set `VITE_TREASURY_ADDRESS`.

### H-03 — Execute V2 testnet lifecycle (depends on H-01)
`bun run v2:testnet-demo --step all`. Fill `evidence/testnet.json → v2Lifecycle`.

---

## MEDIUM

### M-02 — Add Vercel env vars (makes /api/ routes live)
In Vercel dashboard → project → Settings → Environment Variables:

| Variable | Value |
|----------|-------|
| `QUOTE_SIGNER_PRIVATE_KEY` | your D signing key |
| `PROVIDER_PAYOUT_ADDRESS` | `0x7D76349B806148594b8075A83b2f8fb12feaA743` |
| `PROVIDER_NETWORK` | `testnet` |
| `ALLOWED_ORIGIN` | `https://arc-budgetrail.vercel.app` |

Then redeploy. Verify: `curl https://arc-budgetrail.vercel.app/api/health`

### M-04 — Separate C and E addresses before mainnet
`bun run generate:treasury --confirm` on your own machine. Set result in `.env` and `provider/.env`. `bun run v2:preflight --network mainnet` blocks deploy if C == E.

---

## LOW

### L-02 — CI: add workflow PAT scope
Add `workflow` scope to your GitHub PAT, then push `.github/workflows/ci.yml`.

### L-05 — npm publish @budgetrail/sdk
After operator approval and independent security review.

### L-06 — Update AGENTS.md after V2 deploy
Add V2 testnet and mainnet contract addresses after deploy.
