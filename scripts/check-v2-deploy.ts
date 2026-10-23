/**
 * Pre-deploy preflight check for BudgetRailV2.
 *
 * Run before deploying BudgetRailV2 to verify that the constructor
 * arguments are safe. Specifically:
 *   - Treasury E (VITE_TREASURY_ADDRESS) and Provider C (VITE_PROVIDER_PAYOUT)
 *     should NOT be the same address on mainnet, because TREASURY is immutable
 *     in the contract and cannot be changed after deployment.
 *   - Both addresses must be nonzero.
 *   - USDC address must match the expected value for the target chain.
 *
 * This script does NOT deploy. It exits 0 if checks pass (or if C=E on
 * testnet and operator confirms), exits 1 on any blocker.
 *
 * Usage:
 *   bun run scripts/check-v2-deploy.ts [--network testnet|mainnet]
 */

const USDC_ADDRESS_TESTNET = '0x3600000000000000000000000000000000000000';
const USDC_ADDRESS_MAINNET = '0x3600000000000000000000000000000000000000';

const ZERO = '0x0000000000000000000000000000000000000000';

function normalizeAddress(addr: string | undefined): string {
  return (addr ?? '').toLowerCase().trim();
}

function isZero(addr: string): boolean {
  return addr === ZERO || addr === '' || addr === '0x';
}

function main(): void {
  const args = process.argv.slice(2);
  const networkIdx = args.indexOf('--network');
  const network: string = networkIdx >= 0 ? (args[networkIdx + 1] ?? 'testnet') : 'testnet';
  const isMainnet = network === 'mainnet';

  const treasury = normalizeAddress(process.env['VITE_TREASURY_ADDRESS']);
  const provider = normalizeAddress(process.env['VITE_PROVIDER_PAYOUT']);
  const usdc = normalizeAddress(
    isMainnet ? USDC_ADDRESS_MAINNET : USDC_ADDRESS_TESTNET,
  );

  console.log('\n=== BudgetRailV2 pre-deploy preflight ===');
  console.log(`Network:   ${network}`);
  console.log(`USDC:      ${usdc}`);
  console.log(`Treasury E: ${treasury || '(not set)'}`);
  console.log(`Provider C: ${provider || '(not set)'}`);
  console.log('');

  let blocked = false;

  // ── Check 1: Treasury E must be set ────────────────────────────────────────
  if (!treasury || isZero(treasury)) {
    console.error(
      'FAIL [BLOCKER]: VITE_TREASURY_ADDRESS is not set or is the zero address.\n' +
      '  Set it in .env before deploying BudgetRailV2.\n' +
      '  TREASURY is immutable in the contract — it cannot be changed after deployment.',
    );
    blocked = true;
  }

  // ── Check 2: Provider C must be set ────────────────────────────────────────
  if (!provider || isZero(provider)) {
    console.error(
      'FAIL [BLOCKER]: VITE_PROVIDER_PAYOUT is not set or is the zero address.\n' +
      '  Set it in .env before deploying BudgetRailV2.',
    );
    blocked = true;
  }

  // ── Check 3: C=E warning ────────────────────────────────────────────────────
  if (!blocked && treasury && provider && treasury === provider) {
    if (isMainnet) {
      console.error(
        'FAIL [BLOCKER — MAINNET]: Treasury E and Provider C are the same address.\n' +
        `  Both are set to ${treasury}.\n` +
        '  On mainnet, TREASURY is immutable. If you deploy with C=E, the 0.5% platform fee\n' +
        '  will be indistinguishable from provider revenue forever — you cannot separate them\n' +
        '  without deploying a new contract.\n\n' +
        '  Action required:\n' +
        '    1. Generate a separate treasury wallet.\n' +
        '    2. Prove ownership (sign a nonce with the treasury key).\n' +
        '    3. Record the proof in evidence/mainnet.json.\n' +
        '    4. Update VITE_TREASURY_ADDRESS to the new address.\n' +
        '    5. Re-run this check.\n\n' +
        '  If C=E is intentional for this mainnet deployment, acknowledge by adding\n' +
        '  --allow-ce-mainnet to this command. This flag is for testnet-style single-operator\n' +
        '  deployments only and is NOT recommended for production.',
      );
      const allowCeMainnet = args.includes('--allow-ce-mainnet');
      if (!allowCeMainnet) {
        blocked = true;
      } else {
        console.warn(
          'WARN: --allow-ce-mainnet flag set. Proceeding with C=E on mainnet.\n' +
          '  The deploy transaction will emit a TreasuryMatchesProviderWarning event onchain.',
        );
      }
    } else {
      // Testnet: warn but do not block.
      console.warn(
        'WARN [TESTNET ONLY]: Treasury E and Provider C are the same address.\n' +
        `  Both are set to ${treasury}.\n` +
        '  This is acceptable for testnet. Separate addresses before mainnet deployment.\n' +
        '  The deploy transaction will emit a TreasuryMatchesProviderWarning event onchain.',
      );
    }
  }

  // ── Check 4: USDC address sanity ────────────────────────────────────────────
  const expectedUsdc = isMainnet ? USDC_ADDRESS_MAINNET : USDC_ADDRESS_TESTNET;
  if (usdc !== expectedUsdc.toLowerCase()) {
    console.error(
      `FAIL [BLOCKER]: USDC address mismatch for ${network}.\n` +
      `  Expected: ${expectedUsdc}\n` +
      `  Got:      ${usdc}`,
    );
    blocked = true;
  }

  // ── Result ──────────────────────────────────────────────────────────────────
  if (blocked) {
    console.error('\n❌  Pre-deploy check FAILED. Fix the issues above before deploying.\n');
    process.exit(1);
  } else {
    console.log('✅  Pre-deploy check passed. Constructor args are safe to use.\n');
    console.log('Suggested constructor args for BudgetRailV2:');
    console.log(
      JSON.stringify(
        [usdc, treasury || '(treasury not set)', provider || '(provider not set)'],
        null,
        2,
      ),
    );
    console.log(
      '\nNote: The third argument (providerHint) is for the C=E onchain warning only.\n' +
      'It does NOT set the provider in the contract — providers are set per-session.',
    );
    process.exit(0);
  }
}

try {
  main();
} catch (err: unknown) {
  console.error('Preflight script error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
}
