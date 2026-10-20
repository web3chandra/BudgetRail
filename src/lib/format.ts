/**
 * Display formatting utilities — only use for display, never for money math.
 * For money math use @/onchain-money.
 */

/** Format uint96 ERC-20 USDC base units (6 dec) as "$0.000000" */
export function formatUsdc(units: bigint): string {
  const whole    = units / 1_000_000n;
  const fraction = units % 1_000_000n;
  return `$${whole.toString()}.${fraction.toString().padStart(6, "0")}`;
}

/** Shorter: "$0.05" style (2 decimal places) */
export function formatUsdcShort(units: bigint): string {
  const n = Number(units) / 1_000_000;
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6,
  }).format(n);
}

/** Format address as 0x1234...abcd */
export function formatAddr(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
}

/** Format unix timestamp as local date-time string */
export function formatTs(ts: bigint): string {
  return new Date(Number(ts) * 1000).toLocaleString();
}

/** Format unix timestamp as ISO-8601 */
export function formatTsIso(ts: bigint): string {
  return new Date(Number(ts) * 1000).toISOString();
}

/** Minutes remaining from now to a unix timestamp */
export function minsRemaining(ts: bigint): number {
  const secsLeft = Number(ts) - Math.floor(Date.now() / 1000);
  return Math.max(0, Math.floor(secsLeft / 60));
}

/** Whether a timestamp is in the past */
export function isExpired(ts: bigint): boolean {
  return Number(ts) < Math.floor(Date.now() / 1000);
}

/** Session status string */
export function sessionStatus(closed: boolean, expiresAt: bigint): "active" | "expired" | "closed" {
  if (closed) return "closed";
  if (isExpired(expiresAt)) return "expired";
  return "active";
}
