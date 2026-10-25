/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { arcTestnet } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { registerChain } from './tracing'

// Route Arc RPC through /api/rpc (same-origin proxy on Vercel, Vite proxy in sandbox).
// This avoids Brave/Firefox shield blocks and CORS issues with direct RPC calls.
const ARC_RPC_URL = "/api/rpc";

// Pre-register chain RPC URLs so trace events show correct chain names immediately
registerChain(arcTestnet.id, ARC_RPC_URL)

export const config = createConfig({
  chains: [arcTestnet, mainnet], // mainnet needed for ENS resolution
  connectors: [injected()],
  transports: {
    [arcTestnet.id]: http(ARC_RPC_URL),
    [mainnet.id]: http(), // ENS resolution uses mainnet
  },
})
