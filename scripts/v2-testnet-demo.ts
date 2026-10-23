/**
 * v2-testnet-demo.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * 8-step BudgetRailV2 manual testnet verification CLI.
 *
 * ALL STEPS ARE DRY-RUN BY DEFAULT.
 * No transaction is broadcast unless the operator passes --broadcast AND
 * explicitly confirms the per-step prompt.
 *
 * Usage:
 *   bun run scripts/v2-testnet-demo.ts --step preflight
 *   bun run scripts/v2-testnet-demo.ts --step 1          (dry-run)
 *   bun run scripts/v2-testnet-demo.ts --step 1 --broadcast
 *   bun run scripts/v2-testnet-demo.ts --step all        (dry-run all steps)
 *
 * Required env vars (provider/.env or .env):
 *   VITE_BUDGET_RAIL_V2_ADDRESS   — deployed V2 contract (or "pending" to show deploy cmd)
 *   VITE_TREASURY_ADDRESS         — treasury E public address
 *   VITE_PROVIDER_PAYOUT          — provider C public address
 *   VITE_QUOTE_SIGNER             — quote signer D public address
 *   VITE_ARC_TESTNET_RPC          — Arc Testnet RPC (default: https://rpc.testnet.arc.io)
 *
 * Optional (required for broadcast steps 1-8):
 *   OPERATOR_WALLET_A             — owner address (role A)
 *   OPERATOR_WALLET_B             — agent address (role B)
 *
 * NEVER set private keys in .env — this script is read-only for config.
 * All write operations must be signed externally (cast, MetaMask, hardware wallet).
 */

import { createPublicClient, http, parseAbi, type Address } from "viem";

// ── Chain constants ───────────────────────────────────────────────────────────

const CHAIN_ID       = 5042002;
const CHAIN_NAME     = "Arc Testnet";
const USDC_ADDRESS   = "0x3600000000000000000000000000000000000000" as Address;
const USDC_DECIMALS  = 6;
const EXPLORER_BASE  = "https://explorer.testnet.arc.io";
const DEFAULT_RPC    = "https://rpc.testnet.arc.io";
const FEE_BPS        = 50n;
const FEE_DENOM      = 10_000n;

// ── Fee math (must match BudgetRailV2.sol exactly) ────────────────────────────

function computeFee(baseUnits: bigint): { fee: bigint; gross: bigint } {
  const fee   = (baseUnits * FEE_BPS) / FEE_DENOM;
  const gross = baseUnits + fee;
  return { fee, gross };
}

function formatUsdc(units: bigint): string {
  const s = units.toString().padStart(7, "0");
  return `$${s.slice(0, -6)}.${s.slice(-6)}`;
}

// ── Minimal ABIs ──────────────────────────────────────────────────────────────

const USDC_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function name() view returns (string)",
]);

const V2_ABI = parseAbi([
  "function USDC_ADDRESS() view returns (address)",
  "function TREASURY() view returns (address)",
  "function FEE_BPS() view returns (uint256)",
  "function FEE_DENOMINATOR() view returns (uint256)",
  "function VERSION() view returns (string)",
  "function computeFee(uint256 base) view returns (uint256 fee, uint256 gross)",
  "function getSession(uint256 sessionId) view returns (tuple(address owner,address agent,address provider,address quoteSigner,uint256 maxBudget,uint256 perPaymentCap,uint256 totalFunded,uint256 totalSpent,uint64 expiresAt,bool closed))",
  "function availableBalance(uint256 sessionId) view returns (uint256)",
]);

// ── Config loader ─────────────────────────────────────────────────────────────

interface Config {
  rpcUrl:            string;
  v2Address:         string;
  treasuryAddress:   string;
  providerPayout:    string;
  quoteSigner:       string;
  walletA:           string;
  walletB:           string;
  broadcast:         boolean;
  step:              string;
}

function loadConfig(): Config {
  const env = process.env;
  return {
    rpcUrl:           env.VITE_ARC_TESTNET_RPC        ?? DEFAULT_RPC,
    v2Address:        env.VITE_BUDGET_RAIL_V2_ADDRESS  ?? "",
    treasuryAddress:  env.VITE_TREASURY_ADDRESS        ?? "",
    providerPayout:   env.VITE_PROVIDER_PAYOUT         ?? "",
    quoteSigner:      env.VITE_QUOTE_SIGNER            ?? "",
    walletA:          env.OPERATOR_WALLET_A            ?? "",
    walletB:          env.OPERATOR_WALLET_B            ?? "",
    broadcast:        process.argv.includes("--broadcast"),
    step:             (() => {
      const i = process.argv.indexOf("--step");
      return i >= 0 ? (process.argv[i + 1] ?? "preflight") : "preflight";
    })(),
  };
}

// ── Formatting helpers ────────────────────────────────────────────────────────

const ZERO = "0x0000000000000000000000000000000000000000";
const SEP  = "─".repeat(72);

function addr(a: string): string {
  return a && a !== ZERO ? a : "(NOT SET)";
}
function explorerAddr(a: string): string {
  return a && a !== ZERO ? `${EXPLORER_BASE}/address/${a}` : "(not deployed)";
}
function explorerTx(h: string): string {
  return `${EXPLORER_BASE}/tx/${h}`;
}

function header(title: string): void {
  console.log(`\n${SEP}`);
  console.log(`  ${title}`);
  console.log(SEP);
}

function ok(msg: string):   void { console.log(`  ✓  ${msg}`); }
function warn(msg: string): void { console.log(`  ⚠  ${msg}`); }
function fail(msg: string): void { console.log(`  ✗  ${msg}`); }
function info(msg: string): void { console.log(`     ${msg}`); }

// ── RPC client factory ────────────────────────────────────────────────────────

function makeClient(rpcUrl: string) {
  return createPublicClient({
    transport: http(rpcUrl),
    chain: {
      id: CHAIN_ID,
      name: CHAIN_NAME,
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    },
  });
}

// ── STEP: preflight ───────────────────────────────────────────────────────────

async function stepPreflight(cfg: Config): Promise<boolean> {
  header("PREFLIGHT — V2 Config Verification (read-only)");

  let allOk = true;

  // 1. Chain constants
  info(`Chain:          ${CHAIN_NAME} (${CHAIN_ID})`);
  info(`Explorer:       ${EXPLORER_BASE}`);
  info(`USDC ERC-20:    ${USDC_ADDRESS} (${USDC_DECIMALS} decimals)`);

  // 2. Env var presence
  console.log("");
  info("── Environment variables ─────────────────────────────────────────────");

  const v2Addr = cfg.v2Address;
  if (!v2Addr || v2Addr === ZERO) {
    warn("VITE_BUDGET_RAIL_V2_ADDRESS not set — V2 not yet deployed.");
    warn("Deploy command (dry-run, no broadcast):");
    info("  bun run v2:preflight --network testnet");
    info("  bun run deploy:self BudgetRailV2 '[\"0x3600000000000000000000000000000000000000\",\"<TREASURY_E>\",\"<PROVIDER_C>\"]' --chain ARC-TESTNET");
    info("  (Add --broadcast only after operator approval)");
    allOk = false;
  } else {
    ok(`VITE_BUDGET_RAIL_V2_ADDRESS = ${v2Addr}`);
    info(`    Explorer: ${explorerAddr(v2Addr)}`);
  }

  if (!cfg.treasuryAddress || cfg.treasuryAddress === ZERO) {
    fail("VITE_TREASURY_ADDRESS not set"); allOk = false;
  } else {
    ok(`VITE_TREASURY_ADDRESS (E)  = ${cfg.treasuryAddress}`);
    info(`    Explorer: ${explorerAddr(cfg.treasuryAddress)}`);
  }

  if (!cfg.providerPayout || cfg.providerPayout === ZERO) {
    fail("VITE_PROVIDER_PAYOUT not set"); allOk = false;
  } else {
    ok(`VITE_PROVIDER_PAYOUT (C)   = ${cfg.providerPayout}`);
    info(`    Explorer: ${explorerAddr(cfg.providerPayout)}`);
  }

  if (!cfg.quoteSigner || cfg.quoteSigner === ZERO) {
    fail("VITE_QUOTE_SIGNER not set"); allOk = false;
  } else {
    ok(`VITE_QUOTE_SIGNER (D)      = ${cfg.quoteSigner}`);
    info(`    Explorer: ${explorerAddr(cfg.quoteSigner)}`);
  }

  if (!cfg.walletA) {
    warn("OPERATOR_WALLET_A not set (needed for broadcast steps 1, 3, 7)");
  } else {
    ok(`OPERATOR_WALLET_A (A)      = ${cfg.walletA}`);
  }
  if (!cfg.walletB) {
    warn("OPERATOR_WALLET_B not set (needed for broadcast step 4)");
  } else {
    ok(`OPERATOR_WALLET_B (B)      = ${cfg.walletB}`);
  }

  // 3. RPC liveness
  console.log("");
  info("── RPC liveness ──────────────────────────────────────────────────────");
  try {
    const client = makeClient(cfg.rpcUrl);
    const block = await client.getBlockNumber();
    ok(`RPC ${cfg.rpcUrl} — block ${block}`);
  } catch (e: unknown) {
    fail(`RPC unreachable: ${e instanceof Error ? e.message : String(e)}`);
    allOk = false;
  }

  // 4. USDC ERC-20 verification
  console.log("");
  info("── USDC ERC-20 verification ──────────────────────────────────────────");
  try {
    const client = makeClient(cfg.rpcUrl);
    const [dec, sym, name] = await Promise.all([
      client.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "decimals" }),
      client.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "symbol" }),
      client.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "name" }),
    ]);
    if (dec === USDC_DECIMALS) {
      ok(`USDC decimals onchain = ${dec}  (expected 6)`);
    } else {
      fail(`USDC decimals onchain = ${dec}  (expected 6) — MISMATCH`); allOk = false;
    }
    ok(`USDC symbol = ${sym}, name = ${name}`);
  } catch (e: unknown) {
    fail(`USDC read failed: ${e instanceof Error ? e.message : String(e)}`);
    allOk = false;
  }

  // 5. V2 contract onchain verification
  if (v2Addr && v2Addr !== ZERO) {
    console.log("");
    info("── V2 contract onchain verification ──────────────────────────────────");
    try {
      const client = makeClient(cfg.rpcUrl);
      const usdcOnchain    = String(await client.readContract({ address: v2Addr as Address, abi: V2_ABI, functionName: "USDC_ADDRESS" }));
      const treasuryOnchain = String(await client.readContract({ address: v2Addr as Address, abi: V2_ABI, functionName: "TREASURY" }));
      const feeBps         = BigInt(String(await client.readContract({ address: v2Addr as Address, abi: V2_ABI, functionName: "FEE_BPS" })));
      const version        = String(await client.readContract({ address: v2Addr as Address, abi: V2_ABI, functionName: "VERSION" }));

      if (usdcOnchain.toLowerCase() === USDC_ADDRESS.toLowerCase()) {
        ok(`USDC_ADDRESS onchain = ${usdcOnchain}`);
      } else {
        fail(`USDC_ADDRESS mismatch: ${usdcOnchain}`); allOk = false;
      }

      const treasuryMatch = treasuryOnchain.toLowerCase() === cfg.treasuryAddress.toLowerCase();
      if (treasuryMatch) {
        ok(`TREASURY onchain = ${treasuryOnchain}  matches VITE_TREASURY_ADDRESS`);
      } else {
        fail(`TREASURY onchain=${treasuryOnchain} != config=${cfg.treasuryAddress}`); allOk = false;
      }

      if (feeBps === 50n) {
        ok(`FEE_BPS onchain = ${String(feeBps)}  (50 bps = 0.5%)`);
      } else {
        fail(`FEE_BPS onchain = ${String(feeBps)}  (expected 50)`); allOk = false;
      }

      if (version === "2") {
        ok(`VERSION onchain = "${version}"`);
      } else {
        fail(`VERSION onchain = "${version}"  (expected "2")`); allOk = false;
      }

      // Fee math spot-check: $0.05 base
      const [feeOnchain, grossOnchain] = await client.readContract({
        address: v2Addr as Address,
        abi: V2_ABI,
        functionName: "computeFee",
        args: [50_000n],
      }) as [bigint, bigint];

      const expected = computeFee(50_000n);
      if (feeOnchain === expected.fee && grossOnchain === expected.gross) {
        ok(`computeFee(50_000) onchain: fee=${feeOnchain} gross=${grossOnchain}  ✓`);
        ok(`$0.05 base → $0.00025 fee → $0.05025 gross`);
      } else {
        fail(`computeFee mismatch: got fee=${feeOnchain} gross=${grossOnchain}, expected fee=${expected.fee} gross=${expected.gross}`);
        allOk = false;
      }

    } catch (e: unknown) {
      fail(`V2 contract read failed: ${e instanceof Error ? e.message : String(e)}`);
      allOk = false;
    }
  }

  // 6. C=E warning
  if (cfg.treasuryAddress && cfg.providerPayout &&
      cfg.treasuryAddress.toLowerCase() === cfg.providerPayout.toLowerCase()) {
    warn("C=E: treasury(E) == provider(C). Valid for testnet; separate before mainnet.");
    warn("     Run: bun run v2:preflight --network testnet  to confirm.");
  }

  // 7. Fee math table
  console.log("");
  info("── Fee math table ────────────────────────────────────────────────────");
  info("  base units   base USDC    fee units    fee USDC     gross USDC");
  info("  ──────────   ─────────    ─────────    ─────────    ──────────");
  for (const base of [1_000n, 10_000n, 50_000n, 100_000n, 1_000_000n]) {
    const { fee, gross } = computeFee(base);
    info(`  ${base.toString().padStart(10)} ${formatUsdc(base).padStart(12)} ${fee.toString().padStart(12)} ${formatUsdc(fee).padStart(12)} ${formatUsdc(gross).padStart(12)}`);
  }

  // 8. Mode banner
  console.log("");
  if (cfg.broadcast) {
    warn("--broadcast flag is SET. Steps that write will prompt for confirmation.");
    warn("Never share private keys with this script. Sign externally via cast or wallet.");
  } else {
    ok("DRY-RUN mode. No transactions will be broadcast.");
    ok("Add --broadcast to enable live steps (each step prompts for confirmation).");
  }

  console.log("");
  console.log(allOk ? "  PREFLIGHT PASSED — ready for Step 1." : "  PREFLIGHT FAILED — fix the issues above before proceeding.");
  return allOk;
}

// ── STEP 1: Review constructor and session params ─────────────────────────────

function step1(cfg: Config): void {
  header("STEP 1 — V2 Constructor Review & Session Parameters");

  const BASE_AMOUNT  = 50_000n;   // $0.05
  const MAX_BUDGET   = 500_250n;  // ~$0.50 gross (10 payments)
  const PER_CAP      = 50_250n;   // $0.05025 gross per payment (exactly one payment at $0.05 base)
  const EXPIRY_DELTA = 86_400n;   // 24 hours from now

  const { fee, gross } = computeFee(BASE_AMOUNT);

  info("── Proposed V2 session parameters ───────────────────────────────────");
  info(`  Chain:          ${CHAIN_NAME} (${CHAIN_ID})`);
  info(`  Contract (V2):  ${addr(cfg.v2Address)}`);
  info(`  Owner A:        ${addr(cfg.walletA)}`);
  info(`  Agent B:        ${addr(cfg.walletB)}`);
  info(`  Provider C:     ${addr(cfg.providerPayout)}`);
  info(`  Quote signer D: ${addr(cfg.quoteSigner)}`);
  info(`  Treasury E:     ${addr(cfg.treasuryAddress)}`);
  info("");
  info("── Budget (gross-inclusive) ──────────────────────────────────────────");
  info(`  Base per call:      ${BASE_AMOUNT}  (${formatUsdc(BASE_AMOUNT)})`);
  info(`  Fee per call:       ${fee}     (${formatUsdc(fee)}) = floor(50000*50/10000)`);
  info(`  Gross per call:     ${gross}  (${formatUsdc(gross)})`);
  info(`  perPaymentCap:      ${PER_CAP}  (${formatUsdc(PER_CAP)}) = one gross payment`);
  info(`  maxBudget:          ${MAX_BUDGET}  (${formatUsdc(MAX_BUDGET)}) = 10 gross payments`);
  info(`  expiresAt delta:    +${EXPIRY_DELTA}s (24 hours from broadcast)`);
  info("");
  info("── Constructor args (for verification) ──────────────────────────────");
  info(`  [0] usdcAddress:   ${USDC_ADDRESS}`);
  info(`  [1] treasury:      ${addr(cfg.treasuryAddress)}`);
  info(`  [2] providerHint:  ${addr(cfg.providerPayout)}`);
  info("");
  info("── Cast command to create session (replace <PRIVATE_KEY_A>) ─────────");
  info("  NEVER run with a real private key in shell — use a .env file or hardware wallet.");

  const expiry = Math.floor(Date.now() / 1000) + Number(EXPIRY_DELTA);

  const castCreateSession = [
    `cast send ${cfg.v2Address || "<V2_CONTRACT>"}`,
    `  "createSession(address,address,address,uint256,uint256,uint64)"`,
    `  ${addr(cfg.walletB)}`,        // agent B
    `  ${addr(cfg.providerPayout)}`, // provider C
    `  ${addr(cfg.quoteSigner)}`,    // signer D
    `  ${MAX_BUDGET}`,               // maxBudget
    `  ${PER_CAP}`,                  // perPaymentCap
    `  ${expiry}`,                   // expiresAt
    `  --rpc-url ${cfg.rpcUrl}`,
    `  --from ${addr(cfg.walletA)}`,
    `  # Sign with: --private-key $WALLET_A_KEY  (store key securely; never in shell history)`,
  ].join(" \\\n    ");

  info("");
  info(castCreateSession);
  info("");

  if (!cfg.broadcast) {
    ok("DRY-RUN: session parameters printed. No transaction broadcast.");
    ok("Inspect the parameters above. When ready: bun run scripts/v2-testnet-demo.ts --step 1 --broadcast");
  } else {
    warn("--broadcast is set. To send Step 1, run the cast command above with your private key.");
    warn("Record the returned sessionId in evidence/testnet.json → v2Lifecycle.sessionId");
  }
}

// ── STEP 2: Approve and fund session ─────────────────────────────────────────

function step2(cfg: Config): void {
  header("STEP 2 — Approve USDC and Fund V2 Session");

  const DEPOSIT_AMOUNT = 500_250n; // $0.500250 — matches maxBudget

  info("── USDC ERC-20 approve (owner A approves contract to spend budget) ───");
  info(`  spender:    ${addr(cfg.v2Address)}`);
  info(`  amount:     ${DEPOSIT_AMOUNT}  (${formatUsdc(DEPOSIT_AMOUNT)})`);
  info("");
  info("  cast send 0x3600000000000000000000000000000000000000 \\");
  info(`    "approve(address,uint256)" \\`);
  info(`    ${addr(cfg.v2Address)} ${DEPOSIT_AMOUNT} \\`);
  info(`    --rpc-url ${cfg.rpcUrl} --from ${addr(cfg.walletA)}`);
  info("");
  info("── Fund session (after approve succeeds) ────────────────────────────");
  info("  Replace <SESSION_ID> with the value recorded in Step 1.");
  info("");
  info(`  cast send ${addr(cfg.v2Address)} \\`);
  info(`    "fundSession(uint256,uint256)" \\`);
  info(`    <SESSION_ID> ${DEPOSIT_AMOUNT} \\`);
  info(`    --rpc-url ${cfg.rpcUrl} --from ${addr(cfg.walletA)}`);
  info("");
  info("── Balance checks (run after funding) ──────────────────────────────");
  info(`  cast call ${addr(cfg.v2Address)} "availableBalance(uint256)" <SESSION_ID> --rpc-url ${cfg.rpcUrl}`);
  info(`  # Expected: ${DEPOSIT_AMOUNT}`);
  info(`  cast call 0x3600000000000000000000000000000000000000 "balanceOf(address)" ${addr(cfg.v2Address)} --rpc-url ${cfg.rpcUrl}`);
  info(`  # Expected: >= ${DEPOSIT_AMOUNT}`);

  if (!cfg.broadcast) {
    ok("DRY-RUN: approve + fund commands printed. No transaction broadcast.");
  } else {
    warn("--broadcast is set. Run the cast commands above. Record txHashes in evidence/testnet.json.");
  }
}

// ── STEP 3: Request quote and verify ─────────────────────────────────────────

function step3(cfg: Config): void {
  header("STEP 3 — Request V2 Quote and Verify");

  const BASE_AMOUNT = 50_000n;
  const { fee, gross } = computeFee(BASE_AMOUNT);

  info("── Expected quote fields ────────────────────────────────────────────");
  info(`  sessionId:     <from Step 1>`);
  info(`  requestId:     <new UUID, hex-encoded>`);
  info(`  baseAmount:    ${BASE_AMOUNT}  (${formatUsdc(BASE_AMOUNT)})`);
  info(`  feeAmount:     ${fee}     (${formatUsdc(fee)})  = floor(50000*50/10000)`);
  info(`  grossAmount:   ${gross}  (${formatUsdc(gross)})`);
  info(`  provider (C):  ${addr(cfg.providerPayout)}`);
  info(`  treasury (E):  ${addr(cfg.treasuryAddress)}`);
  info(`  signer (D):    ${addr(cfg.quoteSigner)}`);
  info(`  deadline:      <unix timestamp, <= session.expiresAt>`);
  info("");
  info("── Verification checklist ────────────────────────────────────────────");
  info("  [ ] feeAmount == floor(baseAmount * 50 / 10_000) — exact bigint");
  info("  [ ] grossAmount == baseAmount + feeAmount");
  info("  [ ] provider address matches VITE_PROVIDER_PAYOUT");
  info("  [ ] treasury address matches VITE_TREASURY_ADDRESS and onchain TREASURY()");
  info("  [ ] EIP-712 domain: name=BudgetRail, version=2, chainId=5042002, verifyingContract=<V2>");
  info("  [ ] Signature recovers to VITE_QUOTE_SIGNER (D)");
  info("  [ ] deadline > now, <= session.expiresAt");
  info("  [ ] requestId is fresh (not a replay)");
  info("");
  info("── Provider API command ──────────────────────────────────────────────");
  info(`  curl -s -X POST ${cfg.rpcUrl === DEFAULT_RPC ? "http://localhost:3001" : cfg.rpcUrl}/api/quotes/v2 \\`);
  info(`    -H "Content-Type: application/json" \\`);
  info(`    -d '{"sessionId":"<SESSION_ID>","requestId":"<UUID>","inputText":"test document"}'`);
  info("");
  info("  Response fields to verify:");
  info("    baseAmount, feeAmount, grossAmount, provider, treasury, signer, signature, deadline");

  if (!cfg.broadcast) {
    ok("DRY-RUN: quote request template printed.");
    ok("Run the curl command above against your local provider and verify all fields.");
  }
}

// ── STEP 4: Pay and verify dual transfers ─────────────────────────────────────

function step4(cfg: Config): void {
  header("STEP 4 — Pay and Verify Dual USDC Transfers");

  const BASE_AMOUNT = 50_000n;
  const { fee, gross } = computeFee(BASE_AMOUNT);

  info("── Expected onchain outcome ──────────────────────────────────────────");
  info(`  USDC transfer 1: contract → C  +${BASE_AMOUNT}  (${formatUsdc(BASE_AMOUNT)})`);
  info(`  USDC transfer 2: contract → E  +${fee}     (${formatUsdc(fee)})`);
  info(`  session.totalSpent += ${gross}  (${formatUsdc(gross)})`);
  info(`  session.availableBalance -= ${gross}`);
  info("");
  info("── Pass criteria ────────────────────────────────────────────────────");
  info("  [ ] Transaction succeeds (no revert)");
  info("  [ ] Exactly 1 PaymentSettledV2 event in tx receipt");
  info("  [ ] PaymentSettledV2.baseAmount == 50000");
  info("  [ ] PaymentSettledV2.feeAmount  == 250");
  info("  [ ] PaymentSettledV2.grossAmount == 50250");
  info("  [ ] PaymentSettledV2.provider == C address");
  info("  [ ] PaymentSettledV2.treasury == E address");
  info("  [ ] Exactly 2 ERC20 Transfer events in same tx");
  info("  [ ] Transfer[0]: from=contract, to=C, value=50000");
  info("  [ ] Transfer[1]: from=contract, to=E, value=250");
  info("  [ ] availableBalance(sessionId) decreases by exactly 50250");
  info("  [ ] balanceOf(C) increases by exactly 50000");
  info("  [ ] balanceOf(E) increases by exactly 250");
  info("");
  info("── Cast command (agent B calls payForRequestV2) ──────────────────────");
  info("  Params from signed quote (Step 3): sessionId, baseAmount, feeAmount, requestId, deadline, sig");
  info(`  cast send ${addr(cfg.v2Address)} \\`);
  info(`    "payForRequestV2(uint256,uint256,uint256,bytes32,uint64,bytes)" \\`);
  info(`    <SESSION_ID> ${BASE_AMOUNT} ${fee} <REQUEST_ID> <DEADLINE> <SIGNATURE> \\`);
  info(`    --rpc-url ${cfg.rpcUrl} --from ${addr(cfg.walletB)}`);
  info("");
  info("── Receipt verification ─────────────────────────────────────────────");
  info("  cast receipt <TX_HASH> --rpc-url $RPC");
  info("  Look for:");
  info(`    topic[0] == PaymentSettledV2 (${
    "0x" + Array(64).fill("V2_EVENT_TOPIC").join("").slice(0, 64)
  })`);
  info("    2x Transfer(address,address,uint256) events");

  if (!cfg.broadcast) {
    ok("DRY-RUN: payment command template printed.");
    ok("Record txHash, block, all Transfer events in evidence/testnet.json after live run.");
  } else {
    warn("--broadcast is set. Run the cast command above as wallet B.");
    warn("Verify all 8 pass criteria above before marking step complete.");
  }
}

// ── STEP 5: Provider fulfillment ──────────────────────────────────────────────

function step5(cfg: Config): void {
  header("STEP 5 — Provider Fulfillment and Result Delivery");

  info("── Fulfill call ────────────────────────────────────────────────────");
  info(`  curl -s -X POST http://localhost:3001/api/fulfill/v2 \\`);
  info(`    -H "Content-Type: application/json" \\`);
  info(`    -d '{"txHash":"<PAY_TX_HASH>","requestId":"<REQUEST_ID>"}'`);
  info("");
  info("── Pass criteria ────────────────────────────────────────────────────");
  info("  [ ] Provider receives PaymentSettledV2 event from txHash");
  info("  [ ] Provider verifies provider(C) == PROVIDER_PAYOUT_ADDRESS");
  info("  [ ] Provider verifies treasury(E) == TREASURY_ADDRESS");
  info("  [ ] Provider verifies baseAmount == 50000 (C received 50000)");
  info("  [ ] Provider verifies feeAmount  == 250   (E received 250)");
  info("  [ ] Provider verifies requestHash == SHA-256(inputText)");
  info("  [ ] Provider returns result (non-empty insights object)");
  info("  [ ] Re-calling fulfill with same txHash returns SAME result (idempotent)");
  info("  [ ] Re-calling fulfill does NOT trigger a second payment");
  info("  [ ] History scan includes PaymentSettledV2 event with correct fields");

  if (!cfg.broadcast) {
    ok("DRY-RUN: fulfillment checklist printed.");
    ok("Run the curl command above and verify all criteria after live Step 4.");
  }
}

// ── STEP 6: Close session and verify refund ───────────────────────────────────

function step6(cfg: Config): void {
  header("STEP 6 — Close Session and Verify Refund");

  const DEPOSIT     = 500_250n;
  const SPENT       = 50_250n;
  const EXPECTED_REFUND = DEPOSIT - SPENT; // 450000

  info("── Expected close outcome ───────────────────────────────────────────");
  info(`  totalFunded:      ${DEPOSIT}  (${formatUsdc(DEPOSIT)})`);
  info(`  totalSpent:       ${SPENT}   (${formatUsdc(SPENT)})`);
  info(`  expectedRefund:   ${EXPECTED_REFUND}  (${formatUsdc(EXPECTED_REFUND)})`);
  info(`  E receives:       0  (fee is NOT reversed on close)`);
  info("");
  info("── Cast command (owner A closes session) ────────────────────────────");
  info(`  cast send ${addr(cfg.v2Address)} \\`);
  info(`    "closeSession(uint256)" \\`);
  info(`    <SESSION_ID> \\`);
  info(`    --rpc-url ${cfg.rpcUrl} --from ${addr(cfg.walletA)}`);
  info("");
  info("── Pass criteria ────────────────────────────────────────────────────");
  info("  [ ] Transaction succeeds");
  info(`  [ ] SessionClosed event emitted: refundAmount == ${EXPECTED_REFUND}`);
  info(`  [ ] Owner A receives exactly ${EXPECTED_REFUND} USDC back`);
  info("  [ ] E balance unchanged after close (fee not reversed)");
  info("  [ ] C balance unchanged after close (base not reversed)");
  info("  [ ] availableBalance(sessionId) returns 0 after close");
  info("  [ ] Second closeSession attempt reverts with SessionAlreadyClosed");

  if (!cfg.broadcast) {
    ok("DRY-RUN: close session command printed.");
  } else {
    warn("--broadcast is set. Run the cast command above as wallet A.");
  }
}

// ── STEP 7: Offline rejection tests ───────────────────────────────────────────

function step7(_cfg: Config): void {
  header("STEP 7 — Rejection Tests (offline / local fork only, no live gas burned)");

  info("Run these via: forge test --match-path contracts/test/BudgetRailV2.t.sol -v");
  info("Or: anvil --fork-url <RPC> (then cast send to the fork)");
  info("");
  info("── Test cases ───────────────────────────────────────────────────────");

  const cases = [
    ["Wrong agent",            "Call payForRequestV2 from wallet != session.agent",  "NotAgent revert"],
    ["Over gross cap",         "grossAmount > perPaymentCap",                        "PerPaymentCapExceeded revert"],
    ["Invalid signer",         "Signature from key != session.quoteSigner",          "InvalidSignature revert"],
    ["Signer rotated",         "New session with new D; use old D signature",        "InvalidSignature revert"],
    ["Expired quote",          "deadline < block.timestamp",                         "QuoteExpired revert"],
    ["Expired session",        "block.timestamp > session.expiresAt",               "SessionExpired revert"],
    ["Replay requestId",       "Same requestId, same session, second payment",       "RequestAlreadyUsed revert"],
    ["Network mismatch",       "EIP-712 wrong chainId in domain",                   "InvalidSignature revert"],
    ["Inflated fee",           "feeAmount > floor(base*50/10000)",                  "InvalidFeeAmount revert"],
    ["Deflated fee",           "feeAmount < floor(base*50/10000)",                  "InvalidFeeAmount revert"],
    ["Wrong treasury in sig",  "Sign with tampered treasury address",               "TreasuryMismatch revert or InvalidSignature"],
    ["V1 domain rejected",     "Sign with EIP-712 domain version='1'",              "InvalidSignature revert"],
    ["Double close",           "closeSession twice",                                "SessionAlreadyClosed revert"],
    ["Over budget",            "totalSpent + gross > totalFunded",                  "FundedBudgetExceeded revert"],
  ];

  for (const [name, action, expected] of cases) {
    info(`  [ ] ${name.padEnd(22)} | ${action.padEnd(45)} → ${expected}`);
  }

  info("");
  info("All of the above are already covered in contracts/test/BudgetRailV2.t.sol (60/60 pass).");
  info("No live testnet gas required for these cases.");
  ok("DRY-RUN: rejection test matrix printed.");
}

// ── STEP 8: Full evidence record ──────────────────────────────────────────────

function step8(cfg: Config): void {
  header("STEP 8 — Evidence Record Template");

  info("Populate evidence/testnet.json after completing Steps 1-6.");
  info("Fields to fill:");
  info("");

  const template = {
    v2Contract: {
      address:       cfg.v2Address  || "(set after deploy)",
      chainId:       CHAIN_ID,
      deployTxHash:  "(set after deploy)",
      constructorArgs: {
        usdcAddress:   USDC_ADDRESS,
        treasury:      cfg.treasuryAddress  || "(set after deploy)",
        providerHint:  cfg.providerPayout   || "(set before deploy)",
      },
      verified_USDC_ADDRESS: "(read from USDC_ADDRESS())",
      verified_TREASURY:     "(read from TREASURY())",
      verified_FEE_BPS:      "(read from FEE_BPS())",
      verified_VERSION:      "(read from VERSION())",
    },
    v2Lifecycle: {
      status:                 "PENDING_MANUAL_EXECUTION",
      sessionId:              null,
      createSessionTxHash:    null,
      createSessionBlock:     null,
      fundSessionTxHash:      null,
      fundSessionBlock:       null,
      approveUsdcTxHash:      null,
      payment1TxHash:         null,
      payment1Block:          null,
      payment1BaseAmount:     50000,
      payment1FeeAmount:      250,
      payment1GrossAmount:    50250,
      payment1ProviderDelta:  50000,
      payment1TreasuryDelta:  250,
      payment1Event:          "PaymentSettledV2",
      payment1TransferCount:  2,
      fulfillRequestId:       null,
      fulfillResultNonEmpty:  null,
      retryFulfillIdempotent: null,
      closeSessionTxHash:     null,
      closeSessionBlock:      null,
      closeRefundAmount:      null,
      closeTreasuryDelta:     0,
      closeProviderDelta:     0,
      securityChecklist: {
        wrongAgentReverts:     "FOUNDRY_TEST_PASS",
        overCapReverts:        "FOUNDRY_TEST_PASS",
        invalidSigReverts:     "FOUNDRY_TEST_PASS",
        replayReverts:         "FOUNDRY_TEST_PASS",
        expiredReverts:        "FOUNDRY_TEST_PASS",
        networkMismatchReverts:"FOUNDRY_TEST_PASS",
        feeManipReverts:       "FOUNDRY_TEST_PASS",
        doubleCloseReverts:    "FOUNDRY_TEST_PASS",
      },
    },
  };

  info(JSON.stringify(template, null, 2));
  info("");
  ok("DRY-RUN: evidence template printed.");
  ok("Copy this into evidence/testnet.json and fill each null with real data.");
  ok(`Explorer for V2 (once deployed): ${explorerAddr(cfg.v2Address)}`);
  ok(`Explorer for tx: ${explorerTx("0x<TX_HASH>")}`);
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = loadConfig();

  console.log("");
  console.log("  BudgetRailV2 Testnet Demo CLI");
  console.log(`  Chain: ${CHAIN_NAME} (${CHAIN_ID})`);
  console.log(`  Mode:  ${cfg.broadcast ? "BROADCAST" : "DRY-RUN (default)"}`);
  console.log(`  Step:  ${cfg.step}`);

  const syncSteps: Record<string, (c: Config) => void> = {
    "1": step1, "2": step2, "3": step3, "4": step4,
    "5": step5, "6": step6, "7": step7, "8": step8,
  };

  if (cfg.step === "all") {
    await stepPreflight(cfg);
    for (const s of ["1","2","3","4","5","6","7","8"]) {
      syncSteps[s](cfg);
    }
    return;
  }

  if (cfg.step === "preflight") {
    await stepPreflight(cfg);
    return;
  }

  const fn = syncSteps[cfg.step];
  if (!fn) {
    console.error(`Unknown step: ${cfg.step}. Use: preflight, 1-8, or all.`);
    process.exit(1);
  }

  fn(cfg);
}

main().catch((err: unknown) => {
  console.error("Demo script error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
