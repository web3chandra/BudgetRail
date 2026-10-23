/**
 * BudgetRail Agent App — Configuration
 *
 * All addresses and RPC URL are read from environment variables.
 * Copy env.example.txt to .env and fill in your values.
 *
 * ROLES:
 *   A = session owner (creates sessions, deposits USDC, closes/refunds)
 *   B = agent wallet (calls payForRequest; this app runs as B)
 *   C = provider payout (set by provider; receives base USDC per call)
 *   D = quote signer   (provider backend key; signs EIP-712 quotes)
 *   E = treasury        (V2 only; receives 0.5% fee; set in contract)
 *
 * This example app acts as wallet B (agent).
 * The operator must supply AGENT_PRIVATE_KEY for live onchain calls.
 * All read-only/simulation paths work without any private key.
 *
 * NOTE: This is testnet only. Never use on mainnet without independent review.
 */

import type { BudgetRailConfig, BudgetRailV2Config } from "@budgetrail/sdk";

// Arc Testnet chain ID
export const ARC_TESTNET_CHAIN_ID = 5042002;

// Deployed contract addresses (from AGENTS.md)
export const V1_CONTRACT  = "0xf6a13df15ad93c2e2968e1d69c53894a923bda21" as const;
export const V2_CONTRACT  = (process.env["VITE_BUDGET_RAIL_V2_ADDRESS"] ?? "") as `0x${string}`;

// Deploy blocks — used as fromBlock for history scans
export const V1_DEPLOY_BLOCK = 67_538_363n;
export const V2_DEPLOY_BLOCK = 0n; // Updated after V2 deploy

// USDC on Arc (ERC-20 address, 6 decimals)
export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as const;

// Provider configuration — Role C and D
export const PROVIDER_PAYOUT = (
  process.env["VITE_PROVIDER_PAYOUT"] ?? "0x7D76349B806148594b8075A83b2f8fb12feaA743"
) as `0x${string}`;

export const QUOTE_SIGNER = (
  process.env["VITE_QUOTE_SIGNER"] ?? "0x70cd9e6a417b792ecEeA2E033BdfB8F8A8113a4C"
) as `0x${string}`;

// Treasury E (V2 only)
export const TREASURY_ADDRESS = (
  process.env["VITE_TREASURY_ADDRESS"] ?? "0x7D76349B806148594b8075A83b2f8fb12feaA743"
) as `0x${string}`;

// RPC
export const RPC_URL = (
  process.env["VITE_ARC_TESTNET_RPC"] ?? "https://rpc.testnet.arc.io"
);

// Provider API (local dev default)
export const PROVIDER_API_URL = (
  process.env["VITE_PROVIDER_API_URL"] ?? "http://localhost:3001"
);

// ── SDK config objects ──────────────────────────────────────────────────────

export const v1Config: BudgetRailConfig = {
  contractAddress: V1_CONTRACT,
  chainId:         ARC_TESTNET_CHAIN_ID,
  rpcUrl:          RPC_URL,
  providerApiUrl:  PROVIDER_API_URL,
  providerPayout:  PROVIDER_PAYOUT,
  quoteSigner:     QUOTE_SIGNER,
};

export const v2Config: BudgetRailV2Config = {
  // Inherits all V1 fields — same RPC, same provider, same signer key
  ...v1Config,
  // V2-specific
  contractAddress:   V1_CONTRACT,    // V1 field — keep for V1 operations on same config
  v2ContractAddress: V2_CONTRACT,
  treasuryAddress:   TREASURY_ADDRESS,
  v2DeployBlock:     V2_DEPLOY_BLOCK,
};

// Whether the V2 contract is deployed and configured
export const V2_AVAILABLE = Boolean(V2_CONTRACT && V2_CONTRACT !== "0x" && V2_CONTRACT.length === 42);
