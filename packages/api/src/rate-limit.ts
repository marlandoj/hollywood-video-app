import { createHmac } from "node:crypto";

export interface RateLimitRule { limit: number; windowMs: number }

export interface RateLimitDecision { allowed: boolean; remaining: number; retryAfterSeconds: number }

/**
 * Sliding-window request limiter keyed by a keyed hash of the client address
 * (FR-053: the address is recorded for rate limiting only, and every record
 * is deleted after 30 days; the plaintext address is never stored).
 */
export class RateLimiter {
  static readonly RETENTION_MS = 30 * 24 * 3600 * 1000;
  private hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(private secret: string) {}

  clientKey(address: string): string {
    return createHmac("sha256", this.secret).update(address).digest("base64url").slice(0, 32);
  }

  check(scope: string, address: string, rule: RateLimitRule, now = Date.now()): RateLimitDecision {
    this.sweep(now);
    const key = `${scope}:${this.clientKey(address)}`;
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < rule.windowMs);
    if (recent.length >= rule.limit) {
      const oldest = recent[0]!;
      this.hits.set(key, recent);
      return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((oldest + rule.windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, remaining: rule.limit - recent.length, retryAfterSeconds: 0 };
  }

  /** Drops every record older than the 30-day retention window; runs at most once a minute. */
  sweep(now = Date.now()): number {
    if (now - this.lastSweep < 60_000) return 0;
    this.lastSweep = now;
    let removed = 0;
    for (const [key, times] of this.hits) {
      const kept = times.filter((at) => now - at < RateLimiter.RETENTION_MS);
      removed += times.length - kept.length;
      if (kept.length === 0) this.hits.delete(key);
      else this.hits.set(key, kept);
    }
    return removed;
  }

  recordCount(): number {
    let total = 0;
    for (const times of this.hits.values()) total += times.length;
    return total;
  }
}

/**
 * Resolves the client address. Only a deployment that terminates connections
 * at its own reverse proxy may trust X-Forwarded-For; otherwise the header is
 * attacker-controlled and the socket address is used. In trusted mode only the
 * LAST hop counts: that is the value the trusted proxy set, whereas any earlier
 * element was supplied by the client and can be freshly forged per request.
 */
export function clientAddress(request: Request, socketAddress: string | null, trustProxy: boolean): string {
  if (trustProxy) {
    const hops = (request.headers.get("x-forwarded-for") ?? "").split(",").map((hop) => hop.trim()).filter(Boolean);
    const last = hops[hops.length - 1];
    if (last) return last;
  }
  return socketAddress ?? "unknown";
}
