import { describe, expect, it } from "vitest";
import { RateLimitError, SlidingWindowRateLimiter } from "../src/main/security/rate-limiter";

describe("SlidingWindowRateLimiter", () => {
  it("rejects excess calls and allows calls after the window", () => {
    const limiter = new SlidingWindowRateLimiter();
    limiter.consume("realtime", 2, 1_000, 10_000);
    limiter.consume("realtime", 2, 1_000, 10_100);
    expect(() => limiter.consume("realtime", 2, 1_000, 10_200)).toThrow(RateLimitError);
    expect(() => limiter.consume("realtime", 2, 1_000, 11_001)).not.toThrow();
  });

  it("keeps channels independent", () => {
    const limiter = new SlidingWindowRateLimiter();
    limiter.consume("tools", 1, 1_000, 1_000);
    expect(() => limiter.consume("settings", 1, 1_000, 1_000)).not.toThrow();
  });
});
