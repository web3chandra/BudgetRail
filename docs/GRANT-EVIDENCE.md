# BudgetRail — Grant Evidence Checklist

Evidence required for grant submission, mapped to judging criteria.

## Judging criteria mapping

| Criterion | Weight | What to demonstrate |
|-----------|--------|---------------------|
| Real Arc USDC movement | 30% | Fund vault → agent pays provider → owner refunds remainder. MUST be Arc Mainnet for grant submission. Testnet is for development only. |
| Arc Studio usage | 25% | Arc Studio project URL, contract generation, tests, tracing panel, development evidence. |
| Working application | 25% | A useful API result purchased and delivered end-to-end. No phantom success states. |
| Future product potential | 20% | SDK, multi-service design, RepoCheck spec, clear agent-integration story. |

---

## Evidence checklist

### A. Arc Studio provenance
- [ ] Arc Studio project URL: (fill in from project share link)
- [ ] AGENTS.md shows contract address, deploy tx, test counts
- [ ] Contract was generated and deployed using Arc Studio (see docs/arc-studio-provenance.md)

### B. Contract on Arc Testnet (V1 — already deployed)
- [x] Contract address: `0xf6a13df15ad93c2e2968e1d69c53894a923bda21`
- [x] Deploy tx: `0xf33cb9096a45c5cc083fbee4366384f4257f509ab94fe46ec4291e775bc4a5d9`
- [x] Explorer: https://explorer.testnet.arc.io/address/0xf6a13df15ad93c2e2968e1d69c53894a923bda21
- [x] Chain ID: 5042002 (Arc Testnet)
- [x] USDC ERC-20: `0x3600000000000000000000000000000000000000` (6 decimals)
- [x] Foundry tests: 60/60 pass (V1 + V2 unit + invariant + C=E guard — see docs/TEST-REPORT.md)
- [x] Provider tests: 108/108 pass
- [x] SDK tests: 66/66 pass

### B2. V2 Contract on Arc Testnet (NOT YET DEPLOYED — pending operator)
- [ ] Contract address: ___________ (set after deploy; run `bun run v2:preflight --network testnet` first)
- [ ] Deploy tx: ___________
- [ ] Explorer: https://explorer.testnet.arc.io/address/___________
- [ ] Verified: FEE_BPS = 50 onchain (`cast call <addr> 'FEE_BPS()(uint16)' --rpc-url https://rpc.testnet.arc.io`)
- [ ] Verified: TREASURY = intended E address onchain
- [ ] Verified: computeFee(50000) = (250, 50250) onchain

### C. Real testnet USDC movement (must complete manually)
For each step, record the transaction hash and explorer link.

#### Step 1: createSession
- [ ] Tx hash: ___________
- [ ] Explorer: https://explorer.testnet.arc.io/tx/___________
- [ ] Session ID emitted: ___________

#### Step 2: ERC-20 approve
- [ ] Tx hash: ___________
- [ ] Amount approved (base units): ___________

#### Step 3: fundSession
- [ ] Tx hash: ___________
- [ ] Amount deposited: ___________
- [ ] Session totalFunded after: ___________

#### Step 4: payForRequest (agent wallet B)
- [ ] Tx hash: ___________
- [ ] Explorer: https://explorer.testnet.arc.io/tx/___________
- [ ] PaymentSettled topic0 in receipt: `0x5c25b27cd6964ebe086bfeb3f23d3b3a2a086ed5166e11817b2e620cadc5ead5`
- [ ] Amount settled (base units, should be 50000 = $0.05): ___________
- [ ] requestId: ___________
- [ ] Provider received USDC Transfer log: ___________

#### Step 5: /api/fulfill returns result
- [ ] API result type (e.g. wordCount, sentences): ___________
- [ ] requestHash matches SHA-256(input): ___________
- [ ] No result delivered before payment verified: confirmed

#### Step 6: closeSession (owner wallet A)
- [ ] Tx hash: ___________
- [ ] Refunded amount (totalFunded − totalSpent): ___________
- [ ] SessionClosed event emitted: ___________

### D. Application demo evidence
- [ ] Loom / screen recording URL: ___________
- [ ] Recording shows: create session → fund → agent pays → result appears → close → refund
- [ ] Recording shows distinct owner vs agent role (or explicit note that owner=agent was used for testing)
- [ ] No phantom success states visible in recording

### E. Code quality evidence
- [ ] Total automated tests: 234+ (60 Foundry + 108 provider + 66 SDK + frontend/agent — run `bun test` for exact current count)
- [ ] Lint: 0 errors (1 pre-existing warning in Playground.tsx — documented in PENDING.md L-01)
- [ ] TypeScript: 0 errors
- [ ] GitHub repo URL: ___________ (pending public push — P0-A + P0-B must be done first)
- [x] Public frontend URL: `https://arc-budgetrail.vercel.app`
- [x] Public provider health URL: `https://arc-budgetrail.vercel.app/api/health` (needs Vercel env vars)
- [x] .env / secrets not committed: confirmed by .gitignore + git history scan (Part 10)

### F. Future product potential evidence
- [ ] SDK: `packages/sdk/` — typed TypeScript client, 8 public functions, BudgetRailError typed errors
- [ ] RepoCheck design: `examples/provider-api/repocheck.ts` — no new contract needed
- [ ] Examples: `examples/nextjs-owner/`, `examples/node-agent/`
- [ ] Multi-service architecture: one session per provider, service registry in SDK
- [ ] Integrations page in frontend: explains all roles, lifecycle, and API

---

## Program deadline and requirements

**Deadline: November 1, 2026. Eight grants of $500 each.**

Required for submission:
- Arc Studio project URL (public)
- Publicly hosted application URL
- Public GitHub repository
- Deployed Arc **Mainnet** contract address (testnet does NOT satisfy the 30% USDC movement criterion)
- Actual mainnet USDC movement through the contract and app with explorer proof
- Short video showing Arc Studio development process and a real payment
- Short description and public builder profile on the grant platform

---

## Conservative mainnet runbook (testnet must pass first)

**Do not proceed to mainnet without:**
1. All six testnet lifecycle steps above completed with real tx hashes
2. At least one end-to-end recording showing the full flow
3. Independent security review of BudgetRail.sol (not Arc Studio — external reviewer)
4. Confirmation that provider key management meets production security standards
5. Explicit operator approval for each mainnet transaction

**Mainnet deployment steps (approval required for each):**
1. Deploy BudgetRail.sol to Arc Mainnet (same constructor arg: USDC_ADDRESS = 0x3600000000000000000000000000000000000000)
2. Record mainnet contract address in evidence/mainnet.json
3. Update BUDGET_RAIL_MAINNET_ADDRESS in provider config
4. Fund operator wallet with Arc Mainnet USDC
5. Create one test session with small maxBudget (e.g. $1.00)
6. Execute full lifecycle as above
7. Record all mainnet tx hashes in evidence/mainnet.json

**Warning: Arc Studio does not deploy to mainnet, sign mainnet transactions, or hold mainnet funds. All mainnet operations require the operator's own wallet and independent tools.**

---

## What NOT to claim

- Do not claim x402 compatibility — BudgetRail uses a custom quote/payment flow
- Do not claim the smart contract guarantees result accuracy
- Do not claim a comprehensive security audit has been performed
- Do not claim Arc Studio generated anything that was not actually generated in this project
- Do not fabricate transaction hashes, balances, or test results
