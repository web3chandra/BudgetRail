/**
 * Agent CLI configuration.
 *
 * Loaded from environment variables only. The agent private key is NEVER:
 *   - stored in git, .env files committed to version control, or any cloud env
 *   - passed as a CLI argument (visible in ps/shell history)
 *   - logged, returned from an API, or written to any file this process creates
 *
 * Set the key in a LOCAL file (e.g. ~/.budgetrail/agent.env) sourced before
 * running the agent, or in your system keystore / 1Password / HashiCorp Vault
 * and injected via an env-loading wrapper script.
 *
 * Required env variables:
 *   AGENT_PRIVATE_KEY           — 0x-prefixed private key of wallet B
 *   PROVIDER_API_URL            — base URL of the provider API (e.g. http://localhost:3001)
 *   BUDGET_RAIL_PROVIDER_PAYOUT — expected provider payout address C (used for verification)
 *   BUDGET_RAIL_QUOTE_SIGNER    — expected quote signer address D  (used for verification)
 *
 * Optional:
 *   AGENT_NETWORK               — "testnet" (default) | "mainnet"
 *   BUDGET_RAIL_ADDRESS         — override contract address
 *   CONFIRM_TIMEOUT_MS          — ms to wait for operator confirmation (default 60000)
 */

import {
  ARC_TESTNET_CHAIN_ID, ARC_MAINNET_CHAIN_ID,
  ARC_TESTNET_RPC, ARC_MAINNET_RPC,
  ARC_TESTNET_EXPLORER, ARC_MAINNET_EXPLORER,
  BUDGET_RAIL_TESTNET,
} from "./constants.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v?.trim()) throw new Error(`Missing required env variable: ${name}`);
  return v.trim();
}
function optionalEnv(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export interface AgentConfig {
  network:             "testnet" | "mainnet";
  chainId:             number;
  rpcUrl:              string;
  explorerBase:        string;
  contractAddress:     `0x${string}`;
  providerPayoutAddress: `0x${string}`;
  quoteSignerAddress:  `0x${string}`;
  providerApiUrl:      string;
  /** Private key loaded from env — NEVER logged or serialized */
  agentPrivateKey:     `0x${string}`;
  confirmTimeoutMs:    number;
}

export function loadAgentConfig(): AgentConfig {
  const network = optionalEnv("AGENT_NETWORK", "testnet") as "testnet" | "mainnet";
  if (network !== "testnet" && network !== "mainnet") {
    throw new Error("AGENT_NETWORK must be 'testnet' or 'mainnet'");
  }

  const chainId      = network === "testnet" ? ARC_TESTNET_CHAIN_ID : ARC_MAINNET_CHAIN_ID;
  const rpcUrl       = network === "testnet"
    ? optionalEnv("ARC_TESTNET_RPC_URL", ARC_TESTNET_RPC)
    : optionalEnv("ARC_MAINNET_RPC_URL", ARC_MAINNET_RPC);
  const explorerBase = network === "testnet" ? ARC_TESTNET_EXPLORER : ARC_MAINNET_EXPLORER;

  const contractAddress = (
    network === "testnet"
      ? optionalEnv("BUDGET_RAIL_ADDRESS", BUDGET_RAIL_TESTNET)
      : requireEnv("BUDGET_RAIL_ADDRESS")
  ).toLowerCase() as `0x${string}`;

  const agentPrivateKey = requireEnv("AGENT_PRIVATE_KEY") as `0x${string}`;
  if (!agentPrivateKey.startsWith("0x") || agentPrivateKey.length !== 66) {
    throw new Error("AGENT_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string");
  }

  const providerPayoutAddress = requireEnv("BUDGET_RAIL_PROVIDER_PAYOUT").toLowerCase() as `0x${string}`;
  const quoteSignerAddress    = requireEnv("BUDGET_RAIL_QUOTE_SIGNER").toLowerCase() as `0x${string}`;
  const providerApiUrl        = requireEnv("PROVIDER_API_URL").replace(/\/$/, "");
  const confirmTimeoutMs      = parseInt(optionalEnv("CONFIRM_TIMEOUT_MS", "60000"), 10);

  return {
    network,
    chainId,
    rpcUrl,
    explorerBase,
    contractAddress,
    providerPayoutAddress,
    quoteSignerAddress,
    providerApiUrl,
    agentPrivateKey,
    confirmTimeoutMs,
  };
}
