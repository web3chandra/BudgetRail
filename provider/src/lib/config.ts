/**
 * Provider server configuration.
 * All secrets are consumed from environment variables ONLY.
 * Nothing here is written to logs or response bodies.
 */

// ── Chain / contract facts (from onchain-facts registry) ──────────────────
export const ARC_TESTNET_CHAIN_ID  = 5042002;
export const ARC_MAINNET_CHAIN_ID  = 5042;
export const ARC_TESTNET_RPC       = "https://rpc.testnet.arc.io";
export const ARC_MAINNET_RPC       = "https://rpc.mainnet.arc.io";
export const USDC_ADDRESS          = "0x3600000000000000000000000000000000000000";
export const USDC_DECIMALS         = 6;

// ── Runtime config read from env ──────────────────────────────────────────
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env variable: ${name}`);
  return v;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export function loadConfig() {
  // Determine network
  const network = optionalEnv("PROVIDER_NETWORK", "testnet") as "testnet" | "mainnet";
  if (network !== "testnet" && network !== "mainnet") {
    throw new Error("PROVIDER_NETWORK must be 'testnet' or 'mainnet'");
  }

  const chainId = network === "testnet" ? ARC_TESTNET_CHAIN_ID : ARC_MAINNET_CHAIN_ID;
  const rpcUrl  = network === "testnet"
    ? optionalEnv("ARC_TESTNET_RPC_URL", ARC_TESTNET_RPC)
    : requireEnv("ARC_MAINNET_RPC_URL");

  // Contract address for this network
  const contractAddress = (
    network === "testnet"
      ? optionalEnv("BUDGET_RAIL_TESTNET_ADDRESS", "0xf6a13df15ad93c2e2968e1d69c53894a923bda21")
      : requireEnv("BUDGET_RAIL_MAINNET_ADDRESS")
  ).toLowerCase() as `0x${string}`;

  // Provider payout wallet C — receives USDC; address is public
  const providerPayoutAddress = requireEnv("PROVIDER_PAYOUT_ADDRESS").toLowerCase() as `0x${string}`;

  // Quote signer D private key — NEVER logged or returned
  const quoteSignerPrivateKey = requireEnv("QUOTE_SIGNER_PRIVATE_KEY") as `0x${string}`;

  // Quote signer public address — derived at startup, safe to expose in /api/health
  // (imported lazily to avoid circular dep; computed in eip712.ts)
  const quoteSignerAddress = optionalEnv("QUOTE_SIGNER_ADDRESS", "").toLowerCase() as `0x${string}`;

  // Fixed price per call in ERC-20 base units (6 decimals)
  const pricePerCall = BigInt(optionalEnv("PRICE_PER_CALL_BASE_UNITS", "50000")); // $0.05

  // Quote validity window
  const quoteWindowSeconds = parseInt(optionalEnv("QUOTE_WINDOW_SECONDS", "600"), 10); // 10 min

  // Input size limit
  const maxInputBytes = parseInt(optionalEnv("MAX_INPUT_BYTES", "8192"), 10);

  // Rate limit: max quotes per sessionId per minute
  const rateLimitPerMinute = parseInt(optionalEnv("RATE_LIMIT_PER_MINUTE", "10"), 10);

  const port = parseInt(optionalEnv("PORT", "3001"), 10);

  // CORS allowed origin — MUST be set to the frontend URL in production.
  // Use "*" only for local dev; production must use an explicit origin.
  const allowedOrigin = optionalEnv("ALLOWED_ORIGIN", "*");

  // ── V2 config (optional — omit if not yet deployed) ──────────────────────
  // V2 contract address: required env var when V2 is active; empty string means V2 disabled.
  const v2ContractAddress = optionalEnv("BUDGET_RAIL_V2_ADDRESS", "").toLowerCase() as `0x${string}`;

  // Treasury E — immutable in the V2 contract; server MUST verify it matches at startup.
  // Public address only; never a private key.
  const treasuryAddress = optionalEnv("TREASURY_ADDRESS", "").toLowerCase() as `0x${string}`;

  // V2 base price per call (6 decimals). Defaults to same as V1.
  const v2PricePerCall = BigInt(optionalEnv("V2_PRICE_PER_CALL_BASE_UNITS",
    optionalEnv("PRICE_PER_CALL_BASE_UNITS", "50000")));

  return {
    network,
    chainId,
    rpcUrl,
    contractAddress,
    providerPayoutAddress,
    quoteSignerPrivateKey,
    quoteSignerAddress,
    pricePerCall,
    quoteWindowSeconds,
    maxInputBytes,
    rateLimitPerMinute,
    port,
    allowedOrigin,
    // V2 — empty string means V2 routes are disabled
    v2ContractAddress,
    treasuryAddress,
    v2PricePerCall,
  };
}

export type Config = ReturnType<typeof loadConfig>;
