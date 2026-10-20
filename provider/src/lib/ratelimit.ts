/**
 * Simple in-memory token-bucket rate limiter per sessionId.
 * Resets every 60 seconds per bucket.  Stateless across restarts
 * (acceptable for MVP — a persistent store is a post-MVP upgrade).
 */

interface Bucket {
  count:     number;
  windowEnd: number; // unix ms
}

const buckets = new Map<string, Bucket>();

export function checkRateLimit(key: string, limitPerMinute: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.windowEnd) {
    buckets.set(key, { count: 1, windowEnd: now + 60_000 });
    return true;
  }
  if (bucket.count >= limitPerMinute) return false;
  bucket.count++;
  return true;
}
