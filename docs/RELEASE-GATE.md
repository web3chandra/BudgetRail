# BudgetRail — Release Gate

Operator checklist before any public release or mainnet operation.
Last updated: October 2026.

---

## 1. Exact files changed this session

| File | Change |
|------|--------|
| `src/lib/arcProfile.ts` | NEW — centralized Arc network profile selected at build time |
| `src/lib/budgetRail.ts` | Re-exports from arcProfile; removed duplicate PROVIDER_CONFIGURED/providerConfigError |
| `src/pages/Dashboard.tsx` | Fixed 1,000-block lookback → scans from DEPLOY_BLOCK_TESTNET (67,538,363) |
| `src/pages/Playground.tsx` | Session ID input: `type="number"` → `type="text" inputMode="numeric"` (no mouse-wheel) |
| `packages/sdk/package.json` | Added `build` script, proper `exports` with `dist/`, `NOT YET PUBLISHED` note |
| `env.example.txt` | Added VITE_ARC_NETWORK, testnet/mainnet split, mainnet STOP warning |
| `.github/workflows/ci.yml` | Added SDK typecheck + test job; updated test count comments |
| `docs/RELEASE-GATE.md` | THIS FILE |
| `docs/GRANT-EVIDENCE.md` | Updated test counts, corrected mainnet vs testnet requirement language |
| `docs/DEPLOYMENT.md` | Added production hosting section (provider + frontend) |

---

## 2. Identified risks

### P0 — must fix before mainnet

| Risk | Status | Action required |
|------|--------|-----------------|
| No independent security audit of BudgetRail.sol | OPEN | Hire external auditor before any mainnet deploy |
| Provider private key management | OPEN | Rotate from generated dev key to HSM/secrets-manager key |
| Payout wallet C ownership unverified | OPEN | Operator must confirm they control the payout address |
| Mainnet contract not deployed | OPEN | Do not deploy until audit complete |
| CORS on production provider | OPEN | Set `Access-Control-Allow-Origin` to exact frontend domain, not `*` |

### P1 — fix before public demo

| Risk | Status | Action required |
|------|--------|-----------------|
| Quote signer key rotated — sessions 1–8 incompatible | KNOWN | Create new session with current signer key |
| SDK not published to npm | KNOWN | Run `bun run build` in packages/sdk, then `npm publish --access public` when ready |
| RepoCheck wired as example only | KNOWN | Wire to provider routes when mainnet is live |
| Vite dev proxy is not a production API | KNOWN | See production hosting section below |

### P2 — informational

| Risk | Notes |
|------|-------|
| Direct USDC to contract address is unrecoverable | Documented in contract; UI warns users |
| USDC blocklist: if provider wallet is blocklisted, payForRequest reverts | No admin override; MVP limitation |
| Session expiry uses block.timestamp | Minor timestamp drift is acceptable for sessions > 1 day |
| Arc native USDC (18 dec) vs ERC-20 USDC (6 dec) | Never sum both views; frontend uses ERC-20 view only |

---

## 3. Required operator environment variables (names only — never values)

### Frontend build (VITE_* — public, browser-bundled)
```
VITE_ARC_NETWORK           testnet | mainnet
VITE_BUDGET_RAIL_ADDRESS   testnet contract (set for mainnet: VITE_BUDGET_RAIL_MAINNET_ADDRESS)
VITE_PROVIDER_API_URL      base URL of provider API (no /api suffix)
VITE_PROVIDER_PAYOUT       provider payout wallet C public address
VITE_QUOTE_SIGNER          quote signer D public address
```

### Provider server (server-only — never in browser)
```
PROVIDER_PAYOUT_ADDRESS    provider payout wallet C public address
QUOTE_SIGNER_PRIVATE_KEY   quote signer D private key — use HSM or secrets manager
PROVIDER_NETWORK           testnet | mainnet
ARC_TESTNET_RPC_URL        (optional override)
ARC_MAINNET_RPC_URL        (required for mainnet)
BUDGET_RAIL_MAINNET_ADDRESS (required for mainnet)
```

### Agent CLI (local only — never on server or in CI)
```
AGENT_PRIVATE_KEY          agent wallet B private key
PROVIDER_API_URL           URL of running provider
BUDGET_RAIL_ADDRESS        deployed contract address
```

---

## 4. Two-network configuration

| Variable group | Testnet (VITE_ARC_NETWORK=testnet) | Mainnet (VITE_ARC_NETWORK=mainnet) |
|----------------|------------------------------------|------------------------------------|
| Chain ID | 5042002 | 5042 |
| RPC | https://rpc.testnet.arc.io | https://rpc.mainnet.arc.io |
| Explorer | https://explorer.testnet.arc.io | https://explorer.arc.io |
| Contract | 0xf6a13df15ad93c2e2968e1d69c53894a923bda21 | TBD after deploy |
| Deploy block | 67,538,363 | TBD after deploy |
| USDC ERC-20 | 0x3600000000000000000000000000000000000000 | same |

The frontend profile (`src/lib/arcProfile.ts`) selects the correct values at build time.
A testnet build CANNOT make mainnet writes — chain ID mismatch will block the wallet.

---

## 5. Production deployment commands (testnet)

### Provider (Bun — any Linux server with Bun installed)
```bash
# On your server (never in Arc Studio sandbox):
export PROVIDER_PAYOUT_ADDRESS=0x...   # your payout wallet C
export QUOTE_SIGNER_PRIVATE_KEY=0x...  # from secrets manager — never on disk
export PROVIDER_NETWORK=testnet
export PORT=3001

cd provider
bun install --frozen-lockfile
bun run src/index.ts
# Keep alive with systemd, pm2, or Docker
```

Health check: `curl https://your-provider.example.com/api/health`

### Frontend (static hosting — Netlify / Vercel / Cloudflare Pages)
```bash
# Build with your testnet env vars:
VITE_ARC_NETWORK=testnet \
VITE_BUDGET_RAIL_ADDRESS=0xf6a13df15ad93c2e2968e1d69c53894a923bda21 \
VITE_PROVIDER_API_URL=https://your-provider.example.com \
VITE_PROVIDER_PAYOUT=0x... \
VITE_QUOTE_SIGNER=0x... \
bunx vite build

# Output in dist/ — deploy as static files
# Add SPA fallback rewrite rule: /* → /index.html
```

Provider CORS: set `Access-Control-Allow-Origin: https://your-frontend.example.com`
(Not `*` — the frontend sends no credentials but locking to the exact origin is correct.)

### Netlify `_redirects`
```
/* /index.html 200
```

### Vercel `vercel.json`
```json
{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
```

---

## 6. Live no-spend smoke-test checklist

Run these after deploying to a new environment. No wallet signatures, no USDC movement.

- [ ] `GET /api/health` returns `{"status":"ok","chainId":5042002,...,"rpcOk":true}`
- [ ] Frontend loads at `/` without console errors
- [ ] `/playground` loads and shows "Provider unavailable" if env vars are missing
- [ ] `/integrations` loads with role explanation
- [ ] Dashboard shows "Connect your wallet" when no wallet connected
- [ ] New Budget form shows "Provider not configured" banner if QUOTE_SIGNER is zero
- [ ] Manage Session `/sessions/5` loads and shows session data from Arc Testnet
- [ ] Payment History "Load events" returns events from deploy block
- [ ] No VITE_* private key values visible in browser network tab or JS bundle
- [ ] `curl -I https://your-frontend.example.com/playground` returns 200 (not 404)

---

## 7. Contract and repo provenance

| Item | Value |
|------|-------|
| Arc Studio project | https://studio.arc.io (see docs/arc-studio-provenance.md) |
| GitHub repo | https://github.com/web3chandra/BudgetRail |
| Contract on Arc Testnet | 0xf6a13df15ad93c2e2968e1d69c53894a923bda21 |
| Deploy tx | 0xf33cb9096a45c5cc083fbee4366384f4257f509ab94fe46ec4291e775bc4a5d9 |
| Deploy block | 67,538,363 |
| Explorer | https://explorer.testnet.arc.io/address/0xf6a13df15ad93c2e2968e1d69c53894a923bda21 |
| Foundry tests | 59/59 pass |

---

## 8. Manual small-USDC mainnet runbook

**STOP. Do not proceed without:**
1. Independent security audit of BudgetRail.sol (not Arc Studio)
2. All 6 testnet lifecycle steps completed with real tx hashes (see GRANT-EVIDENCE.md)
3. End-to-end recording of testnet flow
4. Explicit operator sign-off on each step below
5. Confirmed ownership of payout wallet C and agent wallet B

**Steps (each requires explicit approval):**
1. Deploy BudgetRail.sol to Arc Mainnet with `usdcAddress = 0x3600000000000000000000000000000000000000`
2. Record mainnet contract address in `evidence/mainnet.json`
3. Set `VITE_ARC_NETWORK=mainnet` and `VITE_BUDGET_RAIL_MAINNET_ADDRESS=0x...` in production build
4. Update `BUDGET_RAIL_MAINNET_ADDRESS` and `PROVIDER_NETWORK=mainnet` in provider env
5. Create one test session with maxBudget = $1.00 (1,000,000 base units)
6. Approve USDC, call fundSession with $0.50
7. Request quote, verify, simulate, then call payForRequest
8. Verify PaymentSettled event in receipt; confirm provider received USDC
9. Call closeSession, confirm refund of $0.45
10. Record ALL tx hashes in `evidence/mainnet.json`

---

## 9. Remaining blockers before mainnet

1. **Independent security audit** — required, not optional
2. **Key management** — QUOTE_SIGNER_PRIVATE_KEY must move from dev-generated key to HSM
3. **Testnet lifecycle** — must complete and record all 6 steps with real tx hashes
4. **Frontend hosted publicly** — required for grant evidence
5. **Short video recording** — required for grant: show Arc Studio, session creation, payment, result, refund
6. **Builder profile** — public profile required on grant platform

**Deadline: November 1, 2026. Eight grants of $500 each.**
