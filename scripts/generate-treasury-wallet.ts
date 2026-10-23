#!/usr/bin/env bun
/**
 * generate-treasury-wallet.ts
 *
 * Generates a fresh Ethereum keypair for use as a dedicated treasury wallet (role E).
 * Use this to SEPARATE treasury E from provider C before V2 mainnet deployment.
 *
 * SECURITY RULES:
 *  - Run this on your own machine, NEVER in Arc Studio or any shared environment.
 *  - The private key printed here is shown ONCE. Store it immediately in a
 *    production secret manager (AWS Secrets Manager, HashiCorp Vault, etc.).
 *  - Never commit the private key to git. Never paste it into any chat.
 *  - After storing the key, record only the PUBLIC ADDRESS in evidence/mainnet.json.
 *
 * Usage:
 *   bun run scripts/generate-treasury-wallet.ts
 *
 * Output:
 *   PUBLIC ADDRESS  — paste into evidence/mainnet.json ownershipProofs.treasuryE.address
 *                     and into BudgetRailV2 constructor arg `treasury`
 *   PRIVATE KEY     — store securely, never share, fund this address with a small
 *                     amount of Arc Mainnet USDC to cover withdrawal gas
 *
 * After generating:
 *   1. Store private key in your secret manager.
 *   2. Add public address to evidence/mainnet.json.
 *   3. Run: bun run v2:preflight --network mainnet
 *      (blocks deploy if C == E on mainnet).
 *   4. Sign a nonce to prove ownership:
 *      cast wallet sign --private-key <KEY> "BudgetRail treasury E ownership proof $(date -u +%Y-%m-%dT%H:%M:%SZ)"
 *   5. Record the signature in evidence/mainnet.json ownershipProofs.treasuryE.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

function main() {
  const isDryRun = process.argv.includes("--dry-run");

  console.log("=".repeat(60));
  console.log("BudgetRail — Treasury Wallet Generator (Role E)");
  console.log("=".repeat(60));
  console.log();
  console.log("PURPOSE: Generate a dedicated treasury address separate from");
  console.log("         provider C. Required before V2 mainnet deployment.");
  console.log();

  if (isDryRun) {
    console.log("[DRY-RUN] No keypair generated. Remove --dry-run to generate.");
    console.log();
    console.log("What this script does:");
    console.log("  1. Generates a cryptographically secure 32-byte private key");
    console.log("  2. Derives the public address (EIP-55 checksummed)");
    console.log("  3. Prints both to stdout ONCE");
    console.log("  4. Does NOT write any file or send any transaction");
    console.log();
    console.log("After running:");
    console.log("  - Store private key in your secret manager immediately");
    console.log("  - Record public address in evidence/mainnet.json");
    console.log("  - Pass public address as 'treasury' constructor arg to BudgetRailV2");
    console.log("  - Run: bun run v2:preflight --network mainnet");
    process.exit(0);
  }

  // Confirm operator intent
  if (!process.argv.includes("--confirm")) {
    console.log("WARNING: This will generate a real private key.");
    console.log("         Run with --confirm to proceed.");
    console.log();
    console.log("  bun run scripts/generate-treasury-wallet.ts --confirm");
    console.log();
    console.log("Do NOT run this in Arc Studio or any shared/cloud environment.");
    console.log("Run it on your own machine with a secure terminal.");
    process.exit(1);
  }

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  console.log("GENERATED TREASURY WALLET (Role E)");
  console.log("-".repeat(60));
  console.log();
  console.log(`PUBLIC ADDRESS  : ${account.address}`);
  console.log();
  console.log(`PRIVATE KEY     : ${privateKey}`);
  console.log();
  console.log("-".repeat(60));
  console.log();
  console.log("NEXT STEPS:");
  console.log("  1. Store PRIVATE KEY in your secret manager RIGHT NOW.");
  console.log("     This is the only time it will be shown.");
  console.log();
  console.log("  2. Add PUBLIC ADDRESS to evidence/mainnet.json:");
  console.log(`     ownershipProofs.treasuryE.address = "${account.address}"`);
  console.log();
  console.log("  3. Sign a nonce to prove ownership (replace <KEY>):");
  console.log(`     cast wallet sign --private-key <KEY> \\`);
  console.log(`       "BudgetRail treasury E ownership proof $(date -u +%Y-%m-%dT%H:%M:%SZ)"`);
  console.log();
  console.log("  4. Record the signature in evidence/mainnet.json.");
  console.log();
  console.log("  5. Run the preflight check (blocks deploy if C == E):");
  console.log("     bun run v2:preflight --network mainnet");
  console.log();
  console.log("  6. Pass PUBLIC ADDRESS as 'treasury' constructor arg when deploying V2.");
  console.log();
  console.log("WARNING: Arc Mainnet treasury E is IMMUTABLE post-deploy.");
  console.log("         Verify ownership before deploying.");
}

main();
