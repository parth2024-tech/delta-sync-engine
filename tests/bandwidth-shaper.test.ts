import { describe, it, expect, vi } from "vitest";
import { TokenBucketLimiter, parseBandwidthString } from "../cli/src/bandwidth-shaper";

describe("Adaptive Bandwidth Shaper (Token Bucket)", () => {
  describe("parseBandwidthString", () => {
    it("parses diverse unit representations accurately", () => {
      expect(parseBandwidthString("")).toBe(0);
      expect(parseBandwidthString(null)).toBe(0);
      expect(parseBandwidthString("1024")).toBe(1024);
      expect(parseBandwidthString("500b")).toBe(500);
      expect(parseBandwidthString("500b/s")).toBe(500);
      expect(parseBandwidthString("64kb")).toBe(64 * 1024);
      expect(parseBandwidthString("64kb/s")).toBe(64 * 1024);
      expect(parseBandwidthString("5MB/s")).toBe(5 * 1024 * 1024);
      expect(parseBandwidthString("10m")).toBe(10 * 1024 * 1024);
      expect(parseBandwidthString("1gb/s")).toBe(1024 * 1024 * 1024);
      expect(parseBandwidthString("2.5mb")).toBe(Math.round(2.5 * 1024 * 1024));
    });

    it("returns 0 for invalid string formats", () => {
      expect(parseBandwidthString("invalid")).toBe(0);
      expect(parseBandwidthString("MB/s")).toBe(0);
    });
  });

  describe("TokenBucketLimiter", () => {
    it("resolves immediately when bandwidth limit is 0 (unlimited)", async () => {
      const limiter = new TokenBucketLimiter(0);
      const start = Date.now();
      await limiter.consume(1000000);
      expect(Date.now() - start).toBeLessThan(50);
    });

    it("consumes burst capacity without delay up to burst limit", async () => {
      // 100 KB/s rate -> 200 KB burst capacity
      const limiter = new TokenBucketLimiter(100 * 1024);
      const start = Date.now();
      await limiter.consume(50 * 1024);
      await limiter.consume(50 * 1024);
      expect(Date.now() - start).toBeLessThan(50);
    });

    it("delays consumption when requesting more tokens than available", async () => {
      // 50 KB/s rate (51200 bytes/sec)
      const rate = 50 * 1024;
      const limiter = new TokenBucketLimiter(rate);

      // Drain all tokens (2x burst = 100KB)
      await limiter.consume(100 * 1024);

      // Next request of 50KB should wait ~1000ms
      // We test a small request of 10KB which takes ~200ms
      const start = Date.now();
      await limiter.consume(10 * 1024);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(100);
    });

    it("updates rate dynamically at runtime", () => {
      const limiter = new TokenBucketLimiter(1000);
      expect(limiter.getRate()).toBe(1000);

      limiter.updateRate(50000);
      expect(limiter.getRate()).toBe(50000);
    });
  });
});
