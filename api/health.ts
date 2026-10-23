/**
 * Vercel serverless function: GET /api/health
 * Delegates to the BudgetRail provider health handler.
 * Secrets (QUOTE_SIGNER_PRIVATE_KEY, PROVIDER_PAYOUT_ADDRESS) are set
 * as Vercel Environment Variables — never in source.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadConfig } from "../provider/src/lib/config.js";
import { handleHealth } from "../provider/src/routes/health.js";

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const config = loadConfig();
    const response = await handleHealth(config);
    const body = await response.text();
    res.status(response.status)
       .setHeader("Content-Type", "application/json")
       .setHeader("Access-Control-Allow-Origin", config.allowedOrigin)
       .send(body);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
}
