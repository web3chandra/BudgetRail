# PENDING — Tasks To Complete

> **How to use this file:**
> When a task is done, delete it from the list below.
> Tasks are grouped by priority. Parts 01–12 are complete; open items start here.
>
> **Critical path to grant submission (Nov 1, 2026):**
> P0-A → P0-B → H-02 → H-01 → P0-C → H-03 → M-01/M-02/M-03 → independent security review → mainnet deploy → lifecycle → recording → submit
>
> See `docs/GO-NOGO-MATRIX.md` for the full decision matrix and minimum viable sequence.

---

## BLOCKING (must complete before any mainnet or public release)

### P0-A — Rotate QUOTE_SIGNER_PRIVATE_KEY
- **Why:** Possible sandbox exposure; treat as compromised until git history confirmed clean.
- **How:**
  1. Generate a new keypair on your own machine (never in this chat).
  2. Update `QUOTE_SIGNER_PRIVATE_KEY` in `provider/.env` (private key).
  3. Update `VITE_QUOTE_SIGNER` in `.env` (derived public address).
  4. Create the next session with the new D address — old sessions continue with the old key until closed.
- **File:** `provider/.env`, `.env`

### P0-B — Fix git remote URL (embedded credential token)
- **Why:** Git remote URL contains an embedded GitHub PAT (`https://<token>@github.com/...`).
  The token is in `.git/config` only (not in history), but must be removed and revoked.
- **How:** Run in terminal: `git remote set-url origin https://github.com/web3chandra/BudgetRail.git`
  Then revoke the token in GitHub Settings → Developer settings → Personal access tokens.
- **File:** `.git/config` (sandbox local, not committed)

### P0-C — Execute V1 testnet lifecycle (for grant evidence)
- **Why:** `evidence/testnet.json → testnetLifecycle` fields are all null.
  Grant submission requires real tx hashes from the 6-step V1 lifecycle.
- **How:** Follow `docs/GRANT-EVIDENCE.md`. Steps: createSession, fund, payForRequest, fulfill, close.
- **File:** `evidence/testnet.json`

---

## HIGH (must complete before V2 testnet demo)

### H-01 — Deploy BudgetRailV2 to Arc Testnet
- **Why:** `VITE_BUDGET_RAIL_V2_ADDRESS` is zero; all V2 frontend and SDK paths are gated behind this.
- **How:**
  1. Confirm treasury E address (currently same as C — see H-02 below).
  2. Run preflight: `bun run v2:preflight --network testnet`
  3. Dry-run deploy: `forge build && bun run deploy:self BudgetRailV2 '[...]' --chain ARC-TESTNET`
  4. Request operator approval for `--broadcast`.
  5. After deploy: set `VITE_BUDGET_RAIL_V2_ADDRESS` in `.env`, set `v2DeployBlock` in `src/lib/arcProfile.ts`.
- **File:** `.env`, `src/lib/arcProfile.ts`, `evidence/testnet.json → v2Contract`

### H-02 — Decide C=E before V2 deploy (immutable after deploy)
- **Why:** Treasury E is immutable in `BudgetRailV2.sol`. If C=E at deploy time, fee revenue
  cannot be separated from provider revenue without redeploying.
- **How:**
  - Option A: Accept C=E for testnet (document it). Separate addresses before mainnet.
  - Option B: Generate a separate treasury wallet now, verify ownership, set `VITE_TREASURY_ADDRESS`.
- **File:** `.env`, `provider/.env`

### H-03 — Execute V2 testnet lifecycle (8 steps)
- **Depends on:** H-01 (V2 deployed), OPERATOR_WALLET_A, OPERATOR_WALLET_B set in `.env`
- **How:** Follow `docs/V2-TESTNET-PLAN.md`.
  Run: `bun run v2:testnet-demo --step all` (dry-run), then step-by-step with `--broadcast`.
- **File:** `evidence/testnet.json → v2Lifecycle`

---

## MEDIUM (must complete before public GitHub release)

### M-01 — Backend: set ALLOWED_ORIGIN for production
- **Why:** Provider defaults to CORS `*` if `ALLOWED_ORIGIN` is not set.
  Any domain can call `/api/quotes` and `/api/fulfill` on a public backend.
- **How:** Set `ALLOWED_ORIGIN=https://arc-budgetrail.vercel.app` in `provider/.env` (and as a Vercel environment variable).
- **File:** `provider/.env`, `env.example.txt` (already updated with example)

### M-02 — Backend: add Vercel env vars so /api/ routes work publicly
- **Why:** The provider API routes are deployed as Vercel serverless functions at
  `https://arc-budgetrail.vercel.app/api/`. They need secrets set as Vercel env vars.
- **How:** In Vercel dashboard → project → Settings → Environment Variables, add:
  - `QUOTE_SIGNER_PRIVATE_KEY` — your D signing key
  - `PROVIDER_PAYOUT_ADDRESS` — `0x7D76349B806148594b8075A83b2f8fb12feaA743`
  - `PROVIDER_NETWORK` — `testnet`
  - `ALLOWED_ORIGIN` — `https://arc-budgetrail.vercel.app`
  Then redeploy. Verify: `curl https://arc-budgetrail.vercel.app/api/health`
- **File:** Vercel dashboard (no code change needed)

### M-03 — Frontend: deployed at arc-budgetrail.vercel.app
- **Status: DONE** — `https://arc-budgetrail.vercel.app` is live (static frontend).
  Provider API routes (`/api/health`, `/api/quotes`, `/api/fulfill`) are present but
  need M-02 Vercel env vars before they respond correctly.

### M-04 — Separate C and E addresses before mainnet
- **Why:** Same as H-02 but for mainnet — legally and operationally required for fee accounting.
- **How:** Run `bun run generate:treasury --confirm` on your own machine (NOT in Arc Studio).
  Store the private key, record the public address, then pass it as the `treasury` constructor arg.
  Run `bun run v2:preflight --network mainnet` — it blocks deploy if C == E.
- **File:** `.env`, `evidence/mainnet.json → ownershipProofs.treasuryE`

---

## LOW (quality / documentation)

### L-02 — CI: add workflow PAT scope for Foundry install
- **Why:** GitHub Actions CI requires a PAT with `workflow` scope to push `.github/workflows/`.
  Currently deferred.
- **How:** Add the `workflow` scope to the GitHub PAT, then push.
- **File:** `.github/workflows/ci.yml`

### L-03 — Add screenshots/recordings to docs
- **Why:** Grant evidence and README would benefit from annotated screenshots showing
  the fee breakdown, dual-transfer receipt, and V1/V2 version banner.
- **How:** Run the testnet demo, screenshot the Playground and History pages.
- **File:** `docs/` (new screenshots directory)

### L-04 — RepoCheck: confirm live integration
- **Why:** `examples/provider-api/repocheck.ts` references a RepoCheck service.
  Its live status has not been confirmed independently.
- **How:** Test the endpoint; if live, mark as confirmed in docs.
- **File:** `examples/provider-api/repocheck.ts`

### L-05 — npm publish for @budgetrail/sdk
- **Why:** SDK is currently a private workspace package; not published.
- **How:** After operator approval and independent review, publish to npm.
- **File:** `packages/sdk/package.json`

### L-06 — Update AGENTS.md after V2 deploy
- **Why:** `AGENTS.md` currently records only the V1 contract address.
  After V2 testnet and mainnet deploys, add the new addresses.
- **File:** `AGENTS.md`

---

## DONE (removed from active tracking)

- Parts 01–12 fully implemented and lint/typecheck clean (0 errors, 0 warnings).
- Frontend deployed: `https://arc-budgetrail.vercel.app`
- Provider API routes deployed as Vercel serverless functions at `https://arc-budgetrail.vercel.app/api/`
- Pre-existing lint warning (payHashRaw) fixed — 0 warnings.
- V1 contract deployed: `0xf6a13df15ad93c2e2968e1d69c53894a923bda21` (Arc Testnet, block 67,538,363).
- Foundry tests: 60/60 pass (V2 unit + invariant).
- Provider tests: 108/108 pass.
- SDK tests: 66/66 pass.
- Frontend lint: 0 errors.
- CORS `ALLOWED_ORIGIN` env var wired (H-04 from Part 10 audit).
- V2 fulfill `requestHash` verification added (H-04 from Part 10 audit).
- C=E deploy guard: `TreasuryMatchesProviderWarning` event + `bun run v2:preflight` blocking check.
- Git history scan: no committed secrets found.
