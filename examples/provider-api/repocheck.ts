/**
 * RepoCheck — example provider service for BudgetRail
 *
 * Accepts a public GitHub repository and exact commit SHA.
 * Fetches dependency manifests from the GitHub Contents API at that exact commit.
 * Queries OSV (https://osv.dev) for known CVEs in discovered packages.
 * Returns a structured, reproducible vulnerability report.
 *
 * This is a REFERENCE IMPLEMENTATION for provider developers.
 * It shows how to integrate a new paid service with BudgetRail's
 * quote → payment → verification → delivery lifecycle.
 *
 * IMPORTANT:
 * - This is NOT a comprehensive security audit.
 * - OSV data is informational; it may be incomplete.
 * - Payment verifies that the workflow was executed, not that the report is complete.
 * - Never guarantee result accuracy via smart contract.
 *
 * Usage: POST /api/repocheck/quotes   (service: "repo-check-v1")
 *        POST /api/repocheck/fulfill
 *
 * Input format: "https://github.com/owner/repo@<40-char-sha>"
 * Example:      "https://github.com/vitejs/vite@abc123..."
 */

// ── Input validation ──────────────────────────────────────────────────────

export interface RepocheckInput {
  repoUrl: string;     // https://github.com/owner/repo
  commitSha: string;   // 40-char hex SHA
  owner: string;
  repo: string;
}

const GITHUB_URL_RE = /^https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/;
const SHA_RE        = /^[0-9a-f]{40}$/i;
// Block private/localhost URLs (SSRF)
const SAFE_HOST_RE  = /^github\.com$/;

/**
 * Parse and validate the input string for RepoCheck.
 * Format: "https://github.com/owner/repo@<sha>"
 */
export function parseRepocheckInput(raw: string): RepocheckInput {
  const atIdx = raw.lastIndexOf("@");
  if (atIdx < 0) throw new Error("Input must be 'https://github.com/owner/repo@<40-char-sha>'");

  const repoUrl   = raw.slice(0, atIdx).trim();
  const commitSha = raw.slice(atIdx + 1).trim();

  const match = GITHUB_URL_RE.exec(repoUrl);
  if (!match) throw new Error(`Invalid GitHub repo URL: ${repoUrl}`);

  // URL host safety check
  try {
    const parsed = new URL(repoUrl);
    if (!SAFE_HOST_RE.test(parsed.hostname)) {
      throw new Error(`Unsupported host: ${parsed.hostname}`);
    }
  } catch {
    throw new Error(`Invalid URL: ${repoUrl}`);
  }

  if (!SHA_RE.test(commitSha)) throw new Error(`Invalid commit SHA: ${commitSha} (must be 40 hex chars)`);

  return { repoUrl, commitSha, owner: match[1], repo: match[2] };
}

// ── Manifest fetcher ──────────────────────────────────────────────────────

type ManifestType = "npm" | "pip" | "go" | "cargo" | "maven";

interface DiscoveredManifest {
  type: ManifestType;
  path: string;
  rawContent: string;
}

const MANIFEST_PATHS: Record<ManifestType, string[]> = {
  npm:   ["package.json", "package-lock.json"],
  pip:   ["requirements.txt", "Pipfile"],
  go:    ["go.mod"],
  cargo: ["Cargo.toml"],
  maven: ["pom.xml"],
};

/**
 * Fetch dependency manifest files from a public GitHub repo at an exact commit.
 * Uses the GitHub Contents API (unauthenticated, rate-limited to 60 req/h).
 * Only fetches known manifest filenames — never constructs arbitrary paths.
 */
export async function fetchManifests(input: RepocheckInput): Promise<DiscoveredManifest[]> {
  const results: DiscoveredManifest[] = [];

  for (const [type, paths] of Object.entries(MANIFEST_PATHS) as [ManifestType, string[]][]) {
    for (const path of paths) {
      const url = `https://api.github.com/repos/${input.owner}/${input.repo}/contents/${path}?ref=${input.commitSha}`;
      try {
        const res = await fetch(url, {
          headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "budgetrail-repocheck/0.1" },
          signal:  AbortSignal.timeout(8_000),
        });
        if (!res.ok) continue;
        const data = await res.json() as { content?: string; encoding?: string };
        if (data.content && data.encoding === "base64") {
          const raw = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf-8");
          results.push({ type, path, rawContent: raw });
        }
      } catch {
        // GitHub API unavailable or file doesn't exist — skip
      }
    }
  }

  return results;
}

// ── Package extractor ─────────────────────────────────────────────────────

export interface Package {
  name: string;
  version: string;
  ecosystem: string;
}

/**
 * Extract package names and versions from manifest content.
 * Returns a conservative list — only packages with parseable versions.
 */
export function extractPackages(manifests: DiscoveredManifest[]): Package[] {
  const packages: Package[] = [];

  for (const manifest of manifests) {
    if (manifest.type === "npm") {
      try {
        const parsed = JSON.parse(manifest.rawContent) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        for (const [name, ver] of Object.entries({ ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) })) {
          // Strip semver range prefixes
          const clean = ver.replace(/^[\^~>=<* ]+/, "").split(/[ |,]/)[0].trim();
          if (clean && /^\d/.test(clean)) {
            packages.push({ name, version: clean, ecosystem: "npm" });
          }
        }
      } catch { /* malformed JSON */ }
    }

    if (manifest.type === "pip") {
      for (const line of manifest.rawContent.split("\n")) {
        const m = /^([A-Za-z0-9_.-]+)[=><]+([0-9][^\s#]*)/.exec(line.trim());
        if (m) packages.push({ name: m[1], version: m[2], ecosystem: "PyPI" });
      }
    }

    if (manifest.type === "go") {
      for (const line of manifest.rawContent.split("\n")) {
        const m = /^\s+([^\s]+)\s+(v[0-9][^\s]*)/.exec(line);
        if (m) packages.push({ name: m[1], version: m[2], ecosystem: "Go" });
      }
    }
  }

  // Limit to first 50 packages to avoid OSV rate limits
  return packages.slice(0, 50);
}

// ── OSV query ─────────────────────────────────────────────────────────────

export interface OsvVulnerability {
  id: string;
  summary: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  affectedVersions: string[];
  references: string[];
}

export interface PackageScanResult {
  package: Package;
  vulnerabilities: OsvVulnerability[];
}

/**
 * Query OSV for known vulnerabilities in a list of packages.
 * Uses the OSV batch API: https://api.osv.dev/v1/querybatch
 * Free, no API key required, rate-limited.
 */
export async function queryOsvBatch(packages: Package[]): Promise<PackageScanResult[]> {
  if (packages.length === 0) return [];

  const queries = packages.map((p) => ({
    package: { name: p.name, ecosystem: p.ecosystem },
    version: p.version,
  }));

  let res: Response;
  try {
    res = await fetch("https://api.osv.dev/v1/querybatch", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ queries }),
      signal:  AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(`OSV API unreachable: ${(err as Error).message}`);
  }

  if (!res.ok) throw new Error(`OSV API returned ${res.status}`);

  const data = await res.json() as { results: Array<{ vulns?: Array<{ id: string; summary?: string; database_specific?: { severity?: string }; references?: Array<{ url: string }>; affected?: Array<{ versions?: string[] }> }> }> };

  return packages.map((pkg, i) => {
    const raw = data.results[i]?.vulns ?? [];
    const vulns: OsvVulnerability[] = raw.map((v) => ({
      id:               v.id,
      summary:          v.summary ?? "No summary",
      severity:         normalizeSeverity(v.database_specific?.severity),
      affectedVersions: (v.affected ?? []).flatMap((a) => a.versions ?? []).slice(0, 10),
      references:       (v.references ?? []).map((r) => r.url).slice(0, 3),
    }));
    return { package: pkg, vulnerabilities: vulns };
  });
}

function normalizeSeverity(raw?: string): OsvVulnerability["severity"] {
  const s = (raw ?? "").toUpperCase();
  if (s === "CRITICAL") return "CRITICAL";
  if (s === "HIGH")     return "HIGH";
  if (s === "MEDIUM")   return "MEDIUM";
  if (s === "LOW")      return "LOW";
  return "UNKNOWN";
}

// ── Report builder ─────────────────────────────────────────────────────────

export interface RepocheckReport {
  /** Service identifier — must match the service registry. */
  service:     "repo-check-v1";
  /** ISO timestamp of when the scan was run. */
  scannedAt:   string;
  /** Canonical input that was paid for. */
  input:       string;
  repoUrl:     string;
  commitSha:   string;
  /** Files inspected. */
  manifests:   string[];
  /** Total packages extracted. */
  packageCount: number;
  /** Summary counts by severity. */
  summary: {
    critical: number;
    high:     number;
    medium:   number;
    low:      number;
    unknown:  number;
    total:    number;
  };
  /** Per-package results. Only packages with ≥1 vulnerability. */
  findings: PackageScanResult[];
  /** Disclaimer — always included. */
  disclaimer: string;
}

/**
 * Run the full RepoCheck scan and return a structured report.
 */
export async function runRepocheck(rawInput: string): Promise<RepocheckReport> {
  const input      = parseRepocheckInput(rawInput);
  const manifests  = await fetchManifests(input);
  const packages   = extractPackages(manifests);
  const scanResults = packages.length > 0 ? await queryOsvBatch(packages) : [];

  const findings = scanResults.filter((r) => r.vulnerabilities.length > 0);
  const counts   = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0, total: 0 };
  for (const r of findings) {
    for (const v of r.vulnerabilities) {
      counts[v.severity.toLowerCase() as keyof typeof counts]++;
      counts.total++;
    }
  }

  return {
    service:      "repo-check-v1",
    scannedAt:    new Date().toISOString(),
    input:        rawInput,
    repoUrl:      input.repoUrl,
    commitSha:    input.commitSha,
    manifests:    manifests.map((m) => m.path),
    packageCount: packages.length,
    summary:      counts,
    findings,
    disclaimer:   "This scan uses public OSV data and is not a comprehensive security audit. Results may be incomplete or contain false positives. You are paying for the workflow, aggregation, and delivery — not for guaranteed accuracy.",
  };
}
