# PENDING — Steps Required Before Production

Last updated: 2026-10-29

---

## WALLETS EXPLAINED (READ THIS FIRST)

BudgetRail uses 5 wallet roles. Here is what each one is, who controls it, and whether
you need a unique address for it on mainnet.

```
Wallet A — SESSION OWNER
  Who:    The person who creates and funds the session (your customer or you during demo)
  Does:   Creates session, adds USDC, closes session, gets refund
  Key:    Needed BY THE USER in their browser wallet (MetaMask, etc.)
  Unique: Yes — one per session. Different customers = different A wallets.
  Private key location: User's own wallet. YOU never hold this key.

Wallet B — AGENT
  Who:    The software agent / AI that calls the API and pays per request
  Does:   Calls payForRequest() to pay for each API call
  Key:    Needed in the agent software (agent/agent.env file, AGENT_PRIVATE_KEY)
  Unique: Yes — one per session. Set when creating the session.
  Private key location: Your agent server or demo script. Keep secret.

Wallet C — PROVIDER PAYOUT  ← YOU control this
  Who:    Your service wallet that RECEIVES USDC from every payment
  Does:   Receives the full service price after each successful API call
  Key:    You do NOT need the private key on any server (it only receives money)
  Unique: One wallet for your whole service. Same C across all sessions.
  Private key location: Your cold wallet / hardware wallet. Never on a server.
  Current testnet value: 0x7D76349B806148594b8075A83b2f8fb12feaA743
  MAINNET: Use a fresh wallet you control. Write down the seed phrase offline.

Wallet D — QUOTE SIGNER  ← YOU control this (backend key)
  Who:    A backend signing key used by the provider API server
  Does:   Signs each quote so the smart contract can verify it
  Key:    MUST be on the server (QUOTE_SIGNER_PRIVATE_KEY in Vercel secrets)
  Unique: One per deployment. NEVER reuse for anything else.
  Private key location: Vercel environment variable (secret). Nowhere else.
  Current testnet address: 0x70cd9e6a417b792ecEeA2E033BdfB8F8A8113a4C
  MAINNET: Generate a brand new key. Update Vercel. Create new sessions with the new D.

Wallet E — TREASURY (V2 ONLY)  ← YOU control this
  Who:    Receives the 0.5% platform fee on every V2 payment
  Does:   Accumulates fee revenue (0.5% of every V2 API call)
  Key:    You do NOT need the private key on any server (it only receives money)
  Unique: MUST be different from C on mainnet (code blocks C=E on mainnet)
  Private key location: Your cold wallet. Never on a server.
  Current testnet value: same as C (allowed on testnet, blocked on mainnet)
  MAINNET: Use a different wallet from C. Fresh wallet with offline seed phrase.

Wallet F — DEPLOYER (one-time use)
  Who:    The wallet that deploys the contract to mainnet
  Does:   Runs `forge create` once. Has no special powers after deploy.
  Key:    Only needed during the deploy command. Delete from server afterward.
  Unique: Use a fresh wallet with just enough USDC for gas.
  Private key location: Only in your terminal during deploy. Never committed.
```

### Summary table

| Role | Name | You control? | Key on server? | Must be unique from others? |
|------|------|-------------|----------------|----------------------------|
| A | Session Owner | No (user's wallet) | No | Yes (per session) |
| B | Agent | Yes (your agent) | Yes (agent.env) | Yes (per session) |
| C | Provider Payout | Yes | No | Yes from E on mainnet |
| D | Quote Signer | Yes | YES (Vercel secret) | Yes — dedicated key only |
| E | Treasury (V2) | Yes | No | Yes from C on mainnet |
| F | Deployer | Yes | Only during deploy | Yes — fresh wallet |

---

## MAINNET MIGRATION STEPS (in order — do NOT skip)

Wait until testnet testing is fully confirmed before starting any step here.

### STEP 1 — Generate fresh mainnet wallets (offline)

You need 3 new wallets for mainnet. Do this on a secure offline machine or hardware wallet.

**Wallet C (Provider Payout) — mainnet version**
- Generate a new wallet. Write down the 12-word seed phrase on paper. Store it safely.
- This wallet will accumulate all your USDC revenue. Treat it like a bank account.
- You will use the ADDRESS only (no private key needed on any server).

**Wallet D (Quote Signer) — mainnet version**
- Generate a new 32-byte private key (use `openssl rand -hex 32` in your terminal).
- Derive the address from the key (use `cast wallet address --private-key 0x<key>`).
- You will put this key in Vercel as `QUOTE_SIGNER_PRIVATE_KEY`.
- NEVER share this key. NEVER commit it. NEVER put it in any file that gets pushed.

**Wallet E (Treasury, V2 only) — mainnet version**
- Generate a new wallet. Write down the seed phrase. Store it separately from C.
- This wallet receives the 0.5% fee from every V2 call.
- Must be a DIFFERENT address from C.

### STEP 2 — Fund Wallet F (deployer) with a small amount of USDC on Arc Mainnet

- On Arc mainnet, USDC is the gas token (you pay gas in USDC).
- Send approximately 1–2 USDC to your deployer wallet F.
- Arc mainnet RPC: `https://rpc.mainnet.arc.io`
- You can bridge USDC from Ethereum/Base to Arc via Circle's CCTP bridge.

### STEP 3 — Update arcProfile.ts with mainnet addresses

Edit `src/lib/arcProfile.ts` — in the `mainnet` section, fill in:
```
VITE_BUDGET_RAIL_ADDRESS        = <leave blank until after deploy>
VITE_BUDGET_RAIL_V2_ADDRESS     = <leave blank until after V2 deploy>
VITE_PROVIDER_PAYOUT            = <new mainnet Wallet C address>
VITE_QUOTE_SIGNER               = <new mainnet Wallet D address>
VITE_TREASURY_ADDRESS           = <new mainnet Wallet E address>
```

### STEP 4 — Deploy V1 contract to Arc Mainnet

Run this command (replace values with your real mainnet values):
```bash
forge create contracts/BudgetRail.sol:BudgetRail \
  --rpc-url https://rpc.mainnet.arc.io \
  --private-key $DEPLOYER_PRIVATE_KEY \
  --broadcast \
  --constructor-args \
    0x3600000000000000000000000000000000000000 \
    <mainnet_wallet_C_address>
```
- Record the deployed contract address and the deploy tx hash.
- Verify on the Arc mainnet explorer.

### STEP 5 — Deploy V2 contract to Arc Mainnet

```bash
forge create contracts/BudgetRailV2.sol:BudgetRailV2 \
  --rpc-url https://rpc.mainnet.arc.io \
  --private-key $DEPLOYER_PRIVATE_KEY \
  --broadcast \
  --constructor-args \
    0x3600000000000000000000000000000000000000 \
    <mainnet_wallet_E_address>
```
- Record the deployed V2 contract address and tx hash.

### STEP 6 — Update all Vercel environment variables for mainnet

Go to Vercel → Settings → Environment Variables. Add/update these for Production:

| Variable | Value |
|----------|-------|
| `VITE_ARC_NETWORK` | `mainnet` |
| `VITE_BUDGET_RAIL_ADDRESS` | V1 contract address from Step 4 |
| `VITE_BUDGET_RAIL_V2_ADDRESS` | V2 contract address from Step 5 |
| `VITE_PROVIDER_PAYOUT` | Wallet C mainnet address |
| `VITE_QUOTE_SIGNER` | Wallet D mainnet address |
| `VITE_TREASURY_ADDRESS` | Wallet E mainnet address |
| `VITE_PROVIDER_API_URL` | `https://arc-budgetrail.vercel.app` |
| `VITE_ARC_TESTNET_RPC` | `https://rpc.mainnet.arc.io` (mainnet RPC) |
| `ARC_TESTNET_RPC_URL` | `https://rpc.mainnet.arc.io` |
| `QUOTE_SIGNER_PRIVATE_KEY` | New mainnet Wallet D private key (secret) |
| `PROVIDER_PAYOUT_ADDRESS` | Wallet C mainnet address |
| `PROVIDER_NETWORK` | `mainnet` |
| `ALLOWED_ORIGIN` | `https://arc-budgetrail.vercel.app` |

Then Redeploy.

### STEP 7 — Update arcProfile.ts deploy blocks

After deploy, get the block number from the explorer for each contract. Edit `src/lib/arcProfile.ts`:
```
deployBlock: <V1_mainnet_deploy_block>
v2DeployBlock: <V2_mainnet_deploy_block>
```
Commit, push, redeploy.

### STEP 8 — Run mainnet lifecycle for grant evidence

With a small amount of USDC (e.g. 0.10 USDC):
1. Owner A creates a session with Agent B, Provider C, Signer D
2. Owner A funds the session (0.10 USDC)
3. Agent B requests a quote from the provider API
4. Agent B calls payForRequest — verify C receives 0.05 USDC
5. Owner A closes session — verify refund of ~0.05 USDC back to A
6. Record all tx hashes in `evidence/mainnet.json`

### STEP 9 — Record demo video

Follow `docs/VIDEO-STORYBOARD.md`. Show the live mainnet transaction on screen.
Label it "Arc Mainnet" clearly. Upload to YouTube or Loom.

### STEP 10 — Submit Arc grant

Go to the official Arc grant portal. Submit with:
- Public GitHub repo URL
- Live app URL: https://arc-budgetrail.vercel.app
- Demo video URL
- At least one mainnet tx hash from Step 8
- Builder profile

---

## IMMEDIATE TODO (do right now before mainnet)

1. Fix `VITE_PROVIDER_API_URL` in Vercel to `https://arc-budgetrail.vercel.app` → Redeploy
2. Test full Playground flow (quote → pay → fulfill) on testnet — confirm it works end to end
3. Confirm you can see sessions #20 and #21 in the Dashboard
4. Only after testnet confirmed working: start mainnet migration from Step 1 above

---

## WHERE EACH PRIVATE KEY LIVES

| Key | Where it lives | What happens if leaked |
|-----|---------------|----------------------|
| Wallet A private key | User's browser wallet | Their session funds at risk — not your problem |
| Wallet B private key | `agent/agent.env` (gitignored) | Agent can be impersonated — rotate session |
| Wallet C private key | Cold wallet / hardware wallet (NEVER on server) | Treasury funds at risk — huge problem |
| Wallet D private key | Vercel secret `QUOTE_SIGNER_PRIVATE_KEY` | Old sessions stop working — rotate key, create new sessions |
| Wallet E private key | Cold wallet / hardware wallet (NEVER on server) | Fee revenue at risk — huge problem |
| Deployer key | Only in terminal during deploy — delete after | Could deploy malicious contracts — delete immediately after use |
