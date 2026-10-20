/**
 * GET /api/health
 *
 * Returns service status, chain config, and the PUBLIC quote signer address.
 * Never returns secrets (private key, internal state, server env values).
 * Returns HTTP 503 when the configured RPC is unreachable.
 */

import { type Config } from "../lib/config.js";
import { makeClient } from "../lib/onchain.js";
import { quoteSignerAddressFromPrivKey } from "../lib/eip712.js";

export async function handleHealth(config: Config): Promise<Response> {
  // Derive the public signer address from the private key (safe to expose)
  let quoteSignerAddress: string;
  try {
    quoteSignerAddress = quoteSignerAddressFromPrivKey(config.quoteSignerPrivateKey);
  } catch {
    return jsonResponse(503, {
      status: "degraded",
      error:  "Quote signer key misconfigured",
    });
  }

  // Check RPC reachability
  let rpcOk = false;
  let blockNumber: string | null = null;
  try {
    const client = makeClient(config);
    const bn = await client.getBlockNumber();
    blockNumber = bn.toString();
    rpcOk = true;
  } catch {
    // RPC unreachable — return 503 per spec
    return jsonResponse(503, {
      status: "degraded",
      error:  "RPC unreachable",
      chainId:          config.chainId,
      contractAddress:  config.contractAddress,
      providerPayout:   config.providerPayoutAddress,
      quoteSignerAddress,
      service:          "document-insights-v1",
      priceBaseUnits:   config.pricePerCall.toString(),
      network:          config.network,
    });
  }

  return jsonResponse(200, {
    status:            "ok",
    chainId:           config.chainId,
    contractAddress:   config.contractAddress,
    providerPayout:    config.providerPayoutAddress,
    quoteSignerAddress,
    service:           "document-insights-v1",
    priceBaseUnits:    config.pricePerCall.toString(),
    usdcAddress:       "0x3600000000000000000000000000000000000000",
    usdcDecimals:      6,
    network:           config.network,
    latestBlock:       blockNumber,
    rpcOk,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
    },
  });
}
