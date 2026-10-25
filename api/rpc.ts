/**
 * Vercel serverless function — Arc Testnet RPC proxy.
 * Forwards JSON-RPC requests server-side so the browser never reaches
 * the upstream RPC directly (avoids Brave/Firefox shield blocks and CORS issues).
 *
 * Route: POST /api/rpc  (configured in vercel.json)
 *
 * Resolution order:
 * 1. Arc Studio sandbox proxy (RPC_PROXY_BASE_URL + RPC_PROXY_TOKEN)
 * 2. ARC_TESTNET_RPC_URL env var (operator sets in Vercel dashboard)
 * 3. VITE_ARC_TESTNET_RPC env var (same value that the frontend uses; set in Vercel dashboard)
 *
 * All three paths read from environment variables — no onchain literals in source.
 * The operator MUST set at least ARC_TESTNET_RPC_URL or VITE_ARC_TESTNET_RPC in Vercel.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

function resolveRpcUrl(): { url: string; source: string } | null {
  // 1. Arc Studio sandbox proxy (always present in sandbox)
  const proxyBase   = process.env.RPC_PROXY_BASE_URL;
  const proxyToken  = process.env.RPC_PROXY_TOKEN;
  const proxyChains = (process.env.RPC_PROXY_CHAINS ?? "").split(",");
  if (proxyBase && proxyToken && proxyChains.includes("Arc_Testnet")) {
    return {
      url: `${proxyBase}/api/rpc/Arc_Testnet?_rpc_token=${proxyToken}`,
      source: "sandbox-proxy",
    };
  }

  // 2. Dedicated Vercel env var (recommended for production)
  const envRpc = process.env.ARC_TESTNET_RPC_URL;
  if (envRpc) return { url: envRpc, source: "ARC_TESTNET_RPC_URL" };

  // 3. Shared VITE_ env var — same value the frontend reads; works because Bun
  //    and Vercel Node serverless both expose VITE_ vars as process.env.*
  const viteRpc = process.env.VITE_ARC_TESTNET_RPC;
  if (viteRpc) return { url: viteRpc, source: "VITE_ARC_TESTNET_RPC" };

  return null;
}

const MAX_BODY = 512 * 1024; // 512 KB
const TIMEOUT_MS = 10_000;   // 10 s

async function fetchWithTimeout(url: string, body: string): Promise<Response> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal:  ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  const origin = req.headers.origin ?? "";
  const allowed = [
    "https://arc-budgetrail.vercel.app",
    "http://localhost:5173",
    "https://insyzu1x669slnbd423a6.preview.studio.arc.io",
  ];
  if (allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST")    { res.status(405).json({ error: "Method not allowed" }); return; }

  const rpcResolved = resolveRpcUrl();
  if (!rpcResolved) {
    res.status(503).json({
      error: "RPC not configured",
      message:
        "Set ARC_TESTNET_RPC_URL (or VITE_ARC_TESTNET_RPC) in Vercel environment variables. " +
        "No funds were spent — retry simulation after configuring the env var.",
    });
    return;
  }

  const body = JSON.stringify(req.body);
  if (body.length > MAX_BODY) { res.status(413).json({ error: "Request too large" }); return; }

  const { url: rpcUrl, source } = rpcResolved;

  try {
    const upstream = await fetchWithTimeout(rpcUrl, body);

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      res.status(upstream.status).json({
        error:   `Upstream RPC error (${source})`,
        status:  upstream.status,
        message: text.slice(0, 200),
      });
      return;
    }

    const data = await upstream.json() as unknown;
    res.setHeader("X-Rpc-Source", source);
    res.status(200).json(data);
  } catch (err) {
    const msg       = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes("abort") || msg.includes("timeout");
    res.status(504).json({
      error:   isTimeout ? "RPC proxy timeout" : "RPC proxy upstream error",
      source,
      message: msg,
    });
  }
}
