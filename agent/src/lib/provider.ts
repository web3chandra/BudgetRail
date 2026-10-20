/**
 * Provider API client for the agent CLI.
 * Calls /api/quotes and /api/fulfill; never retries money transactions.
 */

import type { AgentConfig } from "./config.js";
import type { SignedQuote } from "./eip712.js";

export interface QuoteRequest {
  sessionId: string;
  service:   "document-insights-v1";
  input:     string;
}

export interface FulfillRequest {
  input:  string;
  quote:  SignedQuote;
  txHash: `0x${string}`;
}

export interface DocumentInsights {
  service:                  string;
  characterCount:           number;
  wordCount:                number;
  sentenceCount:            number;
  paragraphCount:           number;
  avgWordsPerSentence:      number;
  avgSentencesPerParagraph: number;
  top10Keywords:            Array<{ word: string; count: number }>;
  extractiveSummary:        string[];
  readabilityTier:          "simple" | "moderate" | "complex";
}

export interface FulfillResponse {
  insights:    DocumentInsights;
  explorerUrl: string;
  txHash:      string;
}

// ── Health check ───────────────────────────────────────────────────────────

export async function checkProviderHealth(config: AgentConfig): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(`${config.providerApiUrl}/api/health`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new Error(
      `Provider API unreachable at ${config.providerApiUrl}: ${(err as Error).message}`
    );
  }
  if (!resp.ok) {
    throw new Error(`Provider /api/health returned ${resp.status}`);
  }
  const data = await resp.json() as Record<string, unknown>;
  if (data.status !== "ok") {
    throw new Error(`Provider reports unhealthy: ${JSON.stringify(data)}`);
  }
}

// ── Request quote ──────────────────────────────────────────────────────────

export async function requestQuote(
  config: AgentConfig,
  req: QuoteRequest,
): Promise<SignedQuote> {
  let resp: Response;
  try {
    resp = await fetch(`${config.providerApiUrl}/api/quotes`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(req),
      signal:  AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(`Provider /api/quotes network error: ${(err as Error).message}`);
  }
  const body = await resp.json() as Record<string, unknown>;
  if (!resp.ok) {
    throw new Error(
      `Provider /api/quotes returned ${resp.status}: ${body.error ?? JSON.stringify(body)}`
    );
  }
  return body as unknown as SignedQuote;
}

// ── Submit fulfillment ─────────────────────────────────────────────────────

/**
 * Call /api/fulfill with the original input, signed quote, and settled tx hash.
 *
 * IMPORTANT: fulfillment is idempotent on the provider side (same input + txHash
 * returns the same result). If the provider is temporarily unavailable, the caller
 * should preserve the (input, quote, txHash) tuple and retry this function later —
 * there is NO need to re-send any onchain transaction.
 */
export async function submitFulfillment(
  config: AgentConfig,
  req: FulfillRequest,
): Promise<FulfillResponse> {
  let resp: Response;
  try {
    resp = await fetch(`${config.providerApiUrl}/api/fulfill`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(req),
      signal:  AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(
      `Provider /api/fulfill network error: ${(err as Error).message}. ` +
      `The payment was already settled onchain. Preserve input+quote+txHash and retry later.`
    );
  }
  const body = await resp.json() as Record<string, unknown>;
  if (!resp.ok) {
    if (resp.status === 402) {
      // Retryable: payment not yet visible to provider node
      throw new RetryableFulfillError(
        `Provider /api/fulfill returned 402 (payment not yet indexed): ` +
        `${body.error ?? JSON.stringify(body)}`
      );
    }
    throw new Error(
      `Provider /api/fulfill returned ${resp.status}: ${body.error ?? JSON.stringify(body)}`
    );
  }
  return body as unknown as FulfillResponse;
}

/** Error that signals the caller may retry /api/fulfill without re-paying */
export class RetryableFulfillError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "RetryableFulfillError";
  }
}
