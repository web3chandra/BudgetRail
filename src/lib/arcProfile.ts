/**
 * Centralized Arc network profile — selected at BUILD time via VITE_ARC_NETWORK.
 *
 * Usage:
 *   VITE_ARC_NETWORK=testnet  (default) → Arc Testnet  chain 5042002
 *   VITE_ARC_NETWORK=mainnet             → Arc Mainnet  chain 5042
 *
 * Every page that needs a chain ID, explorer URL, RPC URL, USDC address,
 * deploy block, or contract address must import from here — NEVER hardcode
 * chain IDs, explorer domains, or contract addresses elsewhere in the frontend.
 *
 * SECURITY: VITE_* vars are bundled into the browser. Only public addresses
 * and network config are allowed here. Never put private keys in VITE_* vars.
 *
 * MAINNET WARNING: Never perform mainnet writes without explicit operator
 * approval and an independent security review of BudgetRail.sol.
 */

export type ArcNetwork = "testnet" | "mainnet";

export interface ArcProfile {
  /** "testnet" | "mainnet" */
  network:          ArcNetwork;
  /** EVM chain ID */
  chainId:          number;
  /** Human-readable chain name */
  chainName:        string;
  /** HTTPS RPC endpoint */
  rpcUrl:           string;
  /** Block explorer base URL (no trailing slash) */
  explorerBase:     string;
  /** Deployed BudgetRail V1 contract address */
  contractAddress:  `0x${string}`;
  /** Block at which V1 contract was deployed (used as getLogs fromBlock lower bound) */
  deployBlock:      bigint;
  /** Deployed BudgetRail V2 contract address (ZERO when not yet deployed) */
  v2ContractAddress: `0x${string}`;
  /** Block at which V2 contract was deployed (0n when not yet deployed) */
  v2DeployBlock:    bigint;
  /** BudgetRail V2 treasury address E (immutable, ZERO when not configured) */
  treasuryAddress:  `0x${string}`;
  /** Canonical USDC ERC-20 address (6 decimals) */
  usdcAddress:      `0x${string}`;
  /** Provider API base URL — no trailing slash, no /api suffix */
  providerApiUrl:   string;
  /** Provider payout wallet C public address */
  providerPayout:   `0x${string}`;
  /** Quote signer D public address */
  quoteSigner:      `0x${string}`;
}

const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;

function readAddr(key: string, fallback: `0x${string}` = ZERO): `0x${string}` {
  const raw = String(import.meta.env[key] ?? fallback);
  return /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() as `0x${string}` : ZERO;
}

function readStr(key: string, fallback: string): string {
  const v: unknown = (import.meta.env as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

/** Network selected at build time. Defaults to "testnet". */
const NETWORK = (readStr("VITE_ARC_NETWORK", "testnet") === "mainnet"
  ? "mainnet"
  : "testnet");

const TESTNET_PROFILE: ArcProfile = {
  network:           "testnet",
  chainId:           5042002,
  chainName:         "Arc Testnet",
  rpcUrl:            readStr("VITE_ARC_TESTNET_RPC", "https://rpc.testnet.arc.io"),
  explorerBase:      "https://explorer.testnet.arc.io",
  contractAddress:   readAddr("VITE_BUDGET_RAIL_ADDRESS", "0xf6a13df15ad93c2e2968e1d69c53894a923bda21"),
  deployBlock:       67_538_363n,
  v2ContractAddress: readAddr("VITE_BUDGET_RAIL_V2_ADDRESS"),
  v2DeployBlock:     0n, // Set after V2 testnet deployment
  treasuryAddress:   readAddr("VITE_TREASURY_ADDRESS"),
  usdcAddress:       "0x3600000000000000000000000000000000000000",
  providerApiUrl:    (() => {
    const raw = readStr("VITE_PROVIDER_API_URL", "");
    return raw.replace(/\/api\/?$/, "").replace(/\/$/, "");
  })(),
  providerPayout:    readAddr("VITE_PROVIDER_PAYOUT"),
  quoteSigner:       readAddr("VITE_QUOTE_SIGNER"),
};

const MAINNET_PROFILE: ArcProfile = {
  network:           "mainnet",
  chainId:           5042,
  chainName:         "Arc Mainnet",
  rpcUrl:            readStr("VITE_ARC_MAINNET_RPC", "https://rpc.mainnet.arc.io"),
  explorerBase:      "https://explorer.arc.io",
  // Mainnet contract addresses MUST be set explicitly — no testnet fallback
  contractAddress:   readAddr("VITE_BUDGET_RAIL_MAINNET_ADDRESS"),
  deployBlock:       0n, // Set after mainnet V1 deployment
  v2ContractAddress: readAddr("VITE_BUDGET_RAIL_V2_MAINNET_ADDRESS"),
  v2DeployBlock:     0n, // Set after mainnet V2 deployment
  treasuryAddress:   readAddr("VITE_TREASURY_MAINNET_ADDRESS"),
  usdcAddress:       "0x3600000000000000000000000000000000000000",
  providerApiUrl:    (() => {
    const raw = readStr("VITE_MAINNET_PROVIDER_API_URL", "");
    return raw.replace(/\/api\/?$/, "").replace(/\/$/, "");
  })(),
  providerPayout:    readAddr("VITE_MAINNET_PROVIDER_PAYOUT"),
  quoteSigner:       readAddr("VITE_MAINNET_QUOTE_SIGNER"),
};

/** The active profile for this build. Import this everywhere. */
export const ARC: ArcProfile = NETWORK === "mainnet" ? MAINNET_PROFILE : TESTNET_PROFILE;

// ── Runtime guards ─────────────────────────────────────────────────────────

/** True when both V1 operator addresses are configured and non-zero. */
export const PROVIDER_CONFIGURED: boolean =
  ARC.providerPayout !== ZERO && ARC.quoteSigner !== ZERO;

/** True when the V2 contract address and treasury are configured and non-zero. */
export const V2_CONFIGURED: boolean =
  ARC.v2ContractAddress !== ZERO && ARC.treasuryAddress !== ZERO;

/**
 * Returns a human-readable error string when provider config is incomplete,
 * or null when everything is set. Show this before allowing any write.
 */
export function providerConfigError(): string | null {
  const missing: string[] = [];
  const prefix = NETWORK === "mainnet" ? "VITE_MAINNET_" : "VITE_";
  if (ARC.providerPayout === ZERO) missing.push(`${prefix}PROVIDER_PAYOUT`);
  if (ARC.quoteSigner    === ZERO) missing.push(`${prefix}QUOTE_SIGNER`);
  if (NETWORK === "mainnet" && ARC.contractAddress === ZERO)
    missing.push("VITE_BUDGET_RAIL_MAINNET_ADDRESS");
  if (missing.length === 0) return null;
  return (
    `Provider not configured for ${ARC.chainName}. ` +
    `Set in .env and restart: ${missing.join(", ")}. ` +
    `These are public addresses only — never put private keys in VITE_* vars.`
  );
}

/**
 * Throws if the current build is for mainnet but the connected chain ID
 * is testnet, or vice versa. Call this before any write operation.
 * (Read-only operations are more permissive — they accept mismatches with a warning.)
 */
export function assertCorrectNetwork(connectedChainId: number): void {
  if (connectedChainId !== ARC.chainId) {
    throw new Error(
      `Wrong network: wallet is on chain ${connectedChainId}, ` +
      `but this build targets ${ARC.chainName} (${ARC.chainId}). ` +
      `Switch your wallet to ${ARC.chainName} before proceeding.`
    );
  }
}
