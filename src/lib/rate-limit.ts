/**
 * In-memory fixed-window rate limiter.
 *
 * Buckets are keyed by an opaque string (typically `ip:<ip>` or
 * `key:<api-key-prefix>`). Each bucket counts requests within a fixed
 * `windowMs` and resets when the window expires. Stale buckets are GC'd
 * every 5 minutes to keep memory bounded.
 *
 * For multi-instance deployments add a Redis hub later; v1 is per-process.
 */

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export interface DropTotals {
  [bucketName: string]: number;
}

class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private drops: DropTotals = {};

  /**
   * Check + record a request against the named bucket. Returns the
   * decision; callers handle 429 themselves.
   *
   * `bucketName` is the metric label ("enroll-ip", "public-ip", "api-key").
   * `key` is the per-actor identifier within that bucket type.
   */
  check(
    bucketName: string,
    key: string,
    limit: number,
    windowMs: number,
  ): RateLimitDecision {
    if (limit <= 0) {
      // Bucket disabled — always allow, don't book a slot.
      return { allowed: true, remaining: Number.POSITIVE_INFINITY, resetAt: 0, limit };
    }
    const fullKey = `${bucketName}:${key}`;
    const now = Date.now();
    let bucket = this.buckets.get(fullKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(fullKey, bucket);
    }
    if (bucket.count >= limit) {
      this.drops[bucketName] = (this.drops[bucketName] ?? 0) + 1;
      return { allowed: false, remaining: 0, resetAt: bucket.resetAt, limit };
    }
    bucket.count += 1;
    return {
      allowed: true,
      remaining: limit - bucket.count,
      resetAt: bucket.resetAt,
      limit,
    };
  }

  /** Snapshot of cumulative drops per bucket name for /api/metrics. */
  getDropTotals(): DropTotals {
    return { ...this.drops };
  }

  /** Drop stale buckets. Called periodically; safe to call directly in tests. */
  gc(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  /** Test-only — clear all state. */
  reset(): void {
    this.buckets.clear();
    this.drops = {};
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __rateLimiter: RateLimiter | undefined;
  // eslint-disable-next-line no-var
  var __rateLimiterGcInterval: ReturnType<typeof setInterval> | undefined;
}

export const rateLimiter: RateLimiter =
  globalThis.__rateLimiter ?? (globalThis.__rateLimiter = new RateLimiter());

if (!globalThis.__rateLimiterGcInterval && process.env.NODE_ENV !== 'test') {
  globalThis.__rateLimiterGcInterval = setInterval(
    () => rateLimiter.gc(),
    5 * 60 * 1000,
  );
  globalThis.__rateLimiterGcInterval.unref?.();
}
