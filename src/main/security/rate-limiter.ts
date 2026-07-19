export class RateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Too many requests. Try again in ${Math.ceil(retryAfterMs / 1_000)} seconds.`);
    this.name = "RateLimitError";
  }
}

export class SlidingWindowRateLimiter {
  private readonly requests = new Map<string, number[]>();

  consume(key: string, limit: number, windowMs: number, now = Date.now()): void {
    const cutoff = now - windowMs;
    const recent = (this.requests.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= limit) {
      throw new RateLimitError(Math.max(1, (recent[0] ?? now) + windowMs - now));
    }
    recent.push(now);
    this.requests.set(key, recent);
  }
}
