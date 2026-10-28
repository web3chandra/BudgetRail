# BudgetRail — Public Release Gate Checklist

> Check each item before pushing to a public GitHub repository or sharing a public URL.
> Never push `.env`, private keys, or recovery files. Never claim mainnet evidence before it exists.

---

## Section 1 — Secret and Credential Safety

- [ ] **1-A** `git log -p | grep -iE "private.?key|secret|0x[0-9a-f]{64}"` returns nothing sensitive
- [ ] **1-B** `.env`, `provider/.env`, `agent/agent.env`, `.circle/` are all in `.gitignore`
- [ ] **1-C** No `QUOTE_SIGNER_PRIVATE_KEY`, `AGENT_PRIVATE_KEY`, or Circle credentials in any committed file
- [ ] **1-D** Git remote URL does not contain an embedded credential token (P0-B: run `git remote -v`)
- [ ] **1-E** `QUOTE_SIGNER_PRIVATE_KEY` rotated (P0-A)
- [ ] **1-F** `env.example.txt` shows only placeholder values (`0x0000...` or `0x...`), not real keys

## Section 2 — Contract and Config Accuracy

- [ ] **2-A** `AGENTS.md` records correct V1 contract address `0xf6a13df15ad93c2e2968e1d69c53894a923bda21` and deploy tx
- [ ] **2-B** `AGENTS.md` records correct V2 contract address after deploy (or clearly states "not yet deployed")
- [ ] **2-C** `evidence/testnet.json` contains only real tx hashes (no fabricated values); all null fields clearly labelled PENDING
- [ ] **2-D** `evidence/mainnet.json` contains only real mainnet data (or clearly all-null PLACEHOLDER)
- [ ] **2-E** `src/lib/arcProfile.ts` mainnet deploy block is real (not 0n unless genuinely not deployed)
- [ ] **2-F** `VITE_BUDGET_RAIL_V2_ADDRESS` set correctly in `.env` (or VersionBanner shows "not deployed" — acceptable for public release if testnet only)
- [ ] **2-G** No testnet address used as a mainnet address in any config file

## Section 3 — Documentation Accuracy

- [ ] **3-A** README quickstart is accurate and runnable (test it from a clean checkout)
- [ ] **3-B** No claim of "mainnet deployed" unless `evidence/mainnet.json` has real data
- [ ] **3-C** No claim of "testnet lifecycle complete" unless `evidence/testnet.json → testnetLifecycle` has real hashes
- [ ] **3-D** `docs/SECURITY.md` open findings are accurately described; no finding is described as "resolved" without evidence
- [ ] **3-E** `docs/GRANT-EVIDENCE.md` scoring weights listed accurately (30% mainnet USDC, 25% Studio, 25% app, 20% potential)
- [ ] **3-F** No phantom success states described in README or docs (e.g. "payment succeeds" without real tx proof)
- [ ] **3-G** Fee disclosure is accurate: 50 bps on V2 purchases only; V1 has no platform fee; deposits/refunds have no fee
- [ ] **3-H** x402 compatibility is NOT claimed (BudgetRail uses its own EIP-712 protocol)
- [ ] **3-I** RepoCheck described as "example/designed service" not as "live production service" unless confirmed

## Section 4 — Code Quality Gates

- [ ] **4-A** `forge test` passes: 119/119 (V1 + V2 unit + V2 invariant; verified Part 11)
- [ ] **4-B** `cd provider && bun test` passes: ~150/150 (verified Part 11)
- [ ] **4-C** `cd agent && bun test src/test/` passes
- [ ] **4-D** `cd packages/sdk && bun test src/` passes: 66/66
- [ ] **4-E** `bun run check` (frontend): 0 errors, 0 warnings (verified Part 11)
- [ ] **4-F** `bun run build` succeeds with no TypeScript errors
- [ ] **4-G** `examples/agent-app` installs and typechecks cleanly from a fresh `bun install`

## Section 5 — Arc Studio Provenance

- [ ] **5-A** `docs/arc-studio-provenance.md` exists and accurately describes what was built in Studio
- [ ] **5-B** Arc Studio project URL is recorded and publicly accessible
- [ ] **5-C** `AGENTS.md` is present and up to date
- [ ] **5-D** Tracing panel evidence available (Studio traces from contract interaction)

## Section 6 — Production Readiness (for mainnet/grant submission)

- [ ] **6-A** Provider backend deployed to public HTTPS URL
- [ ] **6-B** `GET https://<provider>/api/health` returns `{"status":"ok"}` with correct V2 config
- [ ] **6-C** `ALLOWED_ORIGIN` set to production frontend URL in provider config
- [ ] **6-D** Frontend deployed to public URL (Vercel/Netlify/HF Spaces)
- [ ] **6-E** Frontend does NOT use Vite dev proxy (`/rpc`) in production build — uses direct RPC URL
- [ ] **6-F** `VITE_ARC_NETWORK=mainnet` set in production frontend build
- [ ] **6-G** VersionBanner shows correct network, contract address, and deploy block in production
- [ ] **6-H** FeeBreakdown shows base/fee/gross before every V2 payment
- [ ] **6-I** History page shows correct V1/V2 event isolation and coverage metadata

## Section 7 — Grant Submission Requirements

- [ ] **7-A** Arc Mainnet contract deployed and address confirmed on explorer
- [ ] **7-B** Mainnet lifecycle executed: session created, funded, paid ($0.05), result delivered, session closed, refund received
- [ ] **7-C** All mainnet tx hashes in `evidence/mainnet.json` with explorer links
- [ ] **7-D** Screen recording (2-3 min) showing: Studio development → testnet flow → mainnet payment → result
- [ ] **7-E** Public GitHub repository URL recorded
- [ ] **7-F** Public application URL recorded
- [ ] **7-G** Builder profile on grant platform complete
- [ ] **7-H** Submission description truthful: testnet vs mainnet clearly distinguished
- [ ] **7-I** Deadline: November 1, 2026 — submission must be in before this date
