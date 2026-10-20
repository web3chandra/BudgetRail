/**
 * BudgetRail Document Insights Provider API
 *
 * Routes:
 *   GET  /api/health   — service status (public)
 *   POST /api/quotes   — issue a signed EIP-712 quote (no funds move)
 *   POST /api/fulfill  — verify onchain payment and return result
 *
 * Run: bun run provider/src/index.ts
 * Env: see provider/src/lib/config.ts for required variables.
 */

import { loadConfig } from "./lib/config.js";
import { handleHealth } from "./routes/health.js";
import { handleQuotes } from "./routes/quotes.js";
import { handleFulfill } from "./routes/fulfill.js";

// Load and validate config at startup — fail fast on missing secrets
let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
  console.log(`[BudgetRail provider] Starting on chain ${config.chainId} (${config.network})`);
  console.log(`[BudgetRail provider] Contract: ${config.contractAddress}`);
  console.log(`[BudgetRail provider] Payout: ${config.providerPayoutAddress}`);
  // Never log the private key — only the address
} catch (e) {
  console.error("[BudgetRail provider] Config error:", (e as Error).message);
  process.exit(1);
}

Bun.serve({
  port: config.port,

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    let response: Response;

    try {
      if (req.method === "GET" && url.pathname === "/api/health") {
        response = await handleHealth(config);
      } else if (req.method === "POST" && url.pathname === "/api/quotes") {
        response = await handleQuotes(config, req);
      } else if (req.method === "POST" && url.pathname === "/api/fulfill") {
        response = await handleFulfill(config, req);
      } else {
        response = new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
    } catch (e) {
      console.error("[BudgetRail provider] Unhandled error:", e);
      response = new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Attach CORS headers to every response
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(corsHeaders())) {
      headers.set(k, v);
    }
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  },
});

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

console.log(`[BudgetRail provider] Listening on port ${config.port}`);
