/**
 * Vercel serverless function: POST /api/fulfill/v2
 * Verifies onchain V2 dual-transfer payment and returns result.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadConfig } from "../../provider/src/lib/config.js";
import { handleFulfillV2 } from "../../provider/src/routes/fulfillV2.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") {
    const config = loadConfig();
    res.setHeader("Access-Control-Allow-Origin", config.allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const config = loadConfig();
    const body = JSON.stringify(req.body);
    const webReq = new Request("http://localhost/api/fulfill/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const response = await handleFulfillV2(config, webReq);
    const responseBody = await response.text();
    res.status(response.status)
       .setHeader("Content-Type", "application/json")
       .setHeader("Access-Control-Allow-Origin", config.allowedOrigin)
       .send(responseBody);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
}
