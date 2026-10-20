/**
 * Shared constants for the BudgetRail agent CLI.
 * Values are sourced from the same onchain-facts registry as the frontend.
 * Never hardcode chain IDs, RPC URLs, or contract addresses inline.
 */

export const ARC_TESTNET_CHAIN_ID  = 5042002;
export const ARC_MAINNET_CHAIN_ID  = 5042;
export const ARC_TESTNET_RPC       = "https://rpc.testnet.arc.io";
export const ARC_MAINNET_RPC       = "https://rpc.mainnet.arc.io";
export const ARC_TESTNET_EXPLORER  = "https://explorer.testnet.arc.io";
export const ARC_MAINNET_EXPLORER  = "https://explorer.arc.io";

/** USDC ERC-20 — same address on testnet and mainnet for Arc */
export const USDC_ADDRESS          = "0x3600000000000000000000000000000000000000" as `0x${string}`;
/** ERC-20 base units (6 decimals) */
export const USDC_DECIMALS         = 6;
/** Native gas USDC decimals (18 decimals — same pool, different view) */
export const NATIVE_USDC_DECIMALS  = 18;

/** Deployed BudgetRail contract */
export const BUDGET_RAIL_TESTNET   = "0xf6a13df15ad93c2e2968e1d69c53894a923bda21" as `0x${string}`;

/** BudgetRail EIP-712 domain name and version */
export const EIP712_NAME    = "BudgetRail";
export const EIP712_VERSION = "1";

/** Fixed service price in ERC-20 base units ($0.05) */
export const FIXED_PRICE_UNITS = 50_000n;

/** Minimum gas buffer: require at least 0.002 native USDC for gas */
export const MIN_GAS_NATIVE_UNITS = 2_000_000_000_000_000n; // 0.002 * 10^18
