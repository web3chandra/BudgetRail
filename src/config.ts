/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 *
 * Chain selection follows VITE_ARC_NETWORK (testnet | mainnet) via arcProfile.
 * Ethereum mainnet (chain 1) is included only for ENS resolution — it MUST NOT
 * be selected for BudgetRail USDC transactions. Arc Mainnet (chain 5042) is the
 * correct transaction chain when VITE_ARC_NETWORK=mainnet.
 */

import { http, createConfig } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { arcTestnet, arc as arcMainnet } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { registerChain } from './tracing'
import { ARC } from './lib/arcProfile'

// Route Arc RPC through /api/rpc (same-origin proxy on Vercel, Vite proxy in sandbox).
// This avoids Brave/Firefox shield blocks and CORS issues with direct RPC calls.
const ARC_RPC_URL = "/api/rpc";

// Pre-register the active Arc chain RPC so trace events show correct names immediately.
registerChain(ARC.chainId, ARC_RPC_URL);

// Include both Arc Testnet and Arc Mainnet so the wallet can switch on either build.
// Ethereum mainnet is present only for ENS resolution — never used for BudgetRail writes.
export const config = createConfig({
  chains: [arcTestnet, arcMainnet, mainnet],
  connectors: [injected()],
  transports: {
    [arcTestnet.id]:  http(ARC_RPC_URL),
    // Arc Mainnet: same proxy path (api/rpc resolves ARC_TESTNET_RPC_URL or custom RPC env var).
    // The proxy detects the JSON-RPC chain ID from upstream and forwards accordingly.
    [arcMainnet.id]:  http(ARC_RPC_URL),
    [mainnet.id]:     http(), // ENS resolution only — never used for BudgetRail writes
  },
})
