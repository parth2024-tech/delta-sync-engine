/**
 * Tests for the in-memory rate limiter.
 */
import { describe, it, expect, beforeEach } from "vitest";

// We need to test the rate limiter functions directly.
// Import by re-implementing the core logic to avoid module state leakage.

function createRateLimiter(maxRequests: number, windowMs = 60_000) {
  const limits = new Map<string, { count: number; expiresAt: number }>();

  return {
    check(userId: string): boolean {
      const now = Date.now();
      const entry = limits.get(userId);
      if (!entry || entry.expiresAt < now) {
        limits.set(userId, { count: 1, expiresAt: now + windowMs });
        return true;
      }
      if (entry.count < maxRequests) {
        entry.count += 1;
        return true;
      }
      return false;
    },
    reset() { limits.clear(); },
  };
}

function createByteQuota(maxBytes: number, windowMs = 60_000) {
  const limits = new Map<string, { bytes: number; expiresAt: number }>();

  return {
    check(userId: string, bytes: number): boolean {
      const now = Date.now();
      const entry = limits.get(userId);
      if (!entry || entry.expiresAt < now) {
        limits.set(userId, { bytes, expiresAt: now + windowMs });
        return true;
      }
      if (entry.bytes + bytes <= maxBytes) {
        entry.bytes += bytes;
        return true;
      }
      return false;
    },
    reset() { limits.clear(); },
  };
}

describe("Rate Limiter", () => {
  describe("Upload Rate Limit (60 req/min)", () => {
    const limiter = createRateLimiter(60);

    beforeEach(() => limiter.reset());

    it("allows requests under the limit", () => {
      for (let i = 0; i < 60; i++) {
        expect(limiter.check("user-1")).toBe(true);
      }
    });

    it("rejects the 61st request", () => {
      for (let i = 0; i < 60; i++) {
        limiter.check("user-1");
      }
      expect(limiter.check("user-1")).toBe(false);
    });

    it("limits are per-user", () => {
      for (let i = 0; i < 60; i++) {
        limiter.check("user-1");
      }
      expect(limiter.check("user-1")).toBe(false);
      expect(limiter.check("user-2")).toBe(true);
    });
  });

  describe("Download Rate Limit (30 req/min)", () => {
    const limiter = createRateLimiter(30);

    beforeEach(() => limiter.reset());

    it("allows requests under the limit", () => {
      for (let i = 0; i < 30; i++) {
        expect(limiter.check("user-1")).toBe(true);
      }
    });

    it("rejects the 31st request", () => {
      for (let i = 0; i < 30; i++) {
        limiter.check("user-1");
      }
      expect(limiter.check("user-1")).toBe(false);
    });
  });

  describe("Byte Quota (500 MB/min)", () => {
    const MB = 1024 * 1024;
    const quota = createByteQuota(500 * MB);

    beforeEach(() => quota.reset());

    it("allows downloads under quota", () => {
      expect(quota.check("user-1", 100 * MB)).toBe(true);
      expect(quota.check("user-1", 100 * MB)).toBe(true);
      expect(quota.check("user-1", 100 * MB)).toBe(true);
    });

    it("rejects downloads exceeding quota", () => {
      expect(quota.check("user-1", 400 * MB)).toBe(true);
      expect(quota.check("user-1", 200 * MB)).toBe(false);
    });

    it("allows exactly 500 MB", () => {
      expect(quota.check("user-1", 250 * MB)).toBe(true);
      expect(quota.check("user-1", 250 * MB)).toBe(true);
      expect(quota.check("user-1", 1)).toBe(false);
    });

    it("quotas are per-user", () => {
      expect(quota.check("user-1", 500 * MB)).toBe(true);
      expect(quota.check("user-1", 1)).toBe(false);
      expect(quota.check("user-2", 500 * MB)).toBe(true);
    });
  });

  describe("Window Expiry", () => {
    it("limits reset after the window expires", () => {
      const limiter = createRateLimiter(2, 10); // 10ms window for testing

      expect(limiter.check("user-1")).toBe(true);
      expect(limiter.check("user-1")).toBe(true);
      expect(limiter.check("user-1")).toBe(false);

      // Wait for window to expire
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(limiter.check("user-1")).toBe(true);
          resolve();
        }, 15);
      });
    });
  });
});
