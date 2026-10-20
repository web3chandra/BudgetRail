/**
 * BudgetRail Service Registry
 *
 * Versioned manifest of supported provider services.
 * Each entry defines the service ID, display name, price, and input type.
 *
 * When adding a new provider:
 *   1. Add a new ServiceDescriptor here.
 *   2. Implement a provider API that handles the service ID in POST /api/quotes.
 *   3. Create a new session with that provider's payout address and quote signer.
 *   4. Never reuse the same session for a different provider.
 *
 * SECURITY: Never add provider URLs here — URL injection creates SSRF risk.
 * Provider API URLs are set by the operator in config, not in this registry.
 */

import type { ServiceDescriptor } from "./types.js";

export const SERVICE_REGISTRY: readonly ServiceDescriptor[] = [
  {
    id:           "document-insights-v1",
    name:         "Document Insights",
    description:  "Deterministic text analysis: word count, sentence stats, readability, top words, extractive summary. No external API calls.",
    displayPrice: "$0.05 / call",
    priceUnits:   50_000n,
    inputType:    "text",
    maxInputBytes: 8192,
  },
  // RepoCheck is documented here as a planned service.
  // Implementation is in examples/provider-api/repocheck.ts.
  // A new session with the RepoCheck provider's addresses is required.
  {
    id:           "repo-check-v1",
    name:         "RepoCheck — Dependency Vulnerability Scan",
    description:  "Fetches dependency manifests from a public GitHub repo at an exact commit SHA, queries OSV for known CVEs, and returns a structured vulnerability report. Reproducible and verifiable.",
    displayPrice: "$0.05 / scan",
    priceUnits:   50_000n,
    inputType:    "github_repo",
    maxInputBytes: 512,
  },
] as const;

/**
 * Look up a service by ID.
 * Returns undefined when the service is not registered.
 */
export function getServiceById(id: string): ServiceDescriptor | undefined {
  return SERVICE_REGISTRY.find((s) => s.id === id);
}

/**
 * Validate a provider URL before using it.
 * Prevents SSRF by restricting to http/https and blocking private ranges.
 * Returns the URL if valid; throws on any rejection.
 */
export function validateProviderUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid provider URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Provider URL must use http or https, got: ${url.protocol}`);
  }
  // Block private address ranges (SSRF protection)
  const host = url.hostname.toLowerCase();
  const isPrivate =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith(".internal") ||
    host.endsWith(".local");
  // Allow localhost in dev/test mode
  if (isPrivate && process.env["NODE_ENV"] === "production") {
    throw new Error(`Provider URL must be a public hostname in production (got: ${host})`);
  }
  return url;
}
