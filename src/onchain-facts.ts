/**
 * onchain-facts — chain and token constants for BudgetRail.
 *
 * This module provides the same interface that Arc Studio's built-in
 * @/onchain-facts module would provide, using the values from arcProfile.
 *
 * Arc on both testnet (5042002) and mainnet (5042):
 *   - USDC ERC-20: 0x3600000000000000000000000000000000000000 (6 decimals)
 *   - Native gas token IS USDC (18-decimal representation, same pool — not a second asset)
 *   - Never sum native balance + ERC-20 balance; they represent the same funds
 */

import { ARC } from "@/lib/arcProfile";

// ── USDC descriptor ────────────────────────────────────────────────────────

export interface UsdcDescriptor {
  address:  `0x${string}`;
  decimals: number;
  symbol:   string;
  name:     string;
  chainId:  number;
}

// Arc Testnet and Mainnet both use the same USDC ERC-20 address.
const USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as `0x${string}`;

const USDC_DESCRIPTORS: Record<number, UsdcDescriptor> = {
  5042002: { address: USDC_ADDRESS, decimals: 6, symbol: "USDC", name: "USD Coin", chainId: 5042002 },
  5042:    { address: USDC_ADDRESS, decimals: 6, symbol: "USDC", name: "USD Coin", chainId: 5042    },
};

/**
 * Returns the USDC descriptor for the given chain ID, or null if unsupported.
 * Usage: `const USDC = getUsdc(CHAIN_ID)!;`
 */
export function getUsdc(chainId: number): UsdcDescriptor | null {
  return USDC_DESCRIPTORS[chainId] ?? null;
}

// ── Explorer URL builders ──────────────────────────────────────────────────

/**
 * Build a transaction explorer URL for the active network.
 * Called as buildTxExplorerUrl(chainId, txHash) — chainId first.
 */
export function buildTxExplorerUrl(chainId: number, txHash: string): string {
  const base = explorerBaseForChain(chainId);
  return `${base}/tx/${txHash}`;
}

/**
 * Build an address explorer URL for the active network.
 * Called as buildAddressExplorerUrl(chainId, address) — chainId first.
 */
export function buildAddressExplorerUrl(chainId: number, address: string): string {
  const base = explorerBaseForChain(chainId);
  return `${base}/address/${address}`;
}

function explorerBaseForChain(chainId: number): string {
  switch (chainId) {
    case 5042:    return "https://explorer.arc.io";
    case 5042002: return "https://explorer.testnet.arc.io";
    default:      return ARC.explorerBase;
  }
}
