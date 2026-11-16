/**
 * Client-Side Adaptive Bandwidth Shaper (Token Bucket Algorithm).
 *
 * Smooths bursty parallel chunk uploads and prevents uplink saturation
 * by enforcing a configurable byte-per-second ceiling.
 */

export class TokenBucketLimiter {
  private capacity: number;
  private tokens: number;
  private refillRateBytesPerSec: number;
  private lastRefillTimestamp: number;

  constructor(bytesPerSec = 0) {
    this.refillRateBytesPerSec = Math.max(0, bytesPerSec);
    this.capacity = this.refillRateBytesPerSec > 0 ? this.refillRateBytesPerSec * 2 : 0;
    this.tokens = this.capacity;
    this.lastRefillTimestamp = Date.now();
  }

  private refill() {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefillTimestamp) / 1000;
    if (elapsedSeconds > 0) {
      this.tokens = Math.min(
        this.capacity,
        this.tokens + elapsedSeconds * this.refillRateBytesPerSec,
      );
      this.lastRefillTimestamp = now;
    }
  }

  /**
   * Block asynchronously until enough byte tokens are available.
   * If rate is 0 (or unconfigured), resolves immediately without delay.
   */
  public async consume(bytes: number): Promise<void> {
    if (this.refillRateBytesPerSec <= 0 || bytes <= 0) return;

    while (true) {
      this.refill();
      if (this.tokens >= bytes) {
        this.tokens -= bytes;
        return;
      }
      const missingTokens = bytes - this.tokens;
      const waitMs = Math.ceil((missingTokens / this.refillRateBytesPerSec) * 1000);
      await new Promise((resolve) => setTimeout(resolve, Math.max(10, Math.min(waitMs, 500))));
    }
  }

  public updateRate(bytesPerSec: number) {
    this.refillRateBytesPerSec = Math.max(0, bytesPerSec);
    this.capacity = this.refillRateBytesPerSec > 0 ? this.refillRateBytesPerSec * 2 : 0;
    this.tokens = Math.min(this.tokens, this.capacity);
  }

  public getRate(): number {
    return this.refillRateBytesPerSec;
  }
}

/**
 * Parses user input like "5MB/s", "500KB/s", "1GB/s", "10M" into bytes per second.
 */
export function parseBandwidthString(str?: string | null): number {
  if (!str) return 0;
  const cleaned = str.trim().toLowerCase().replace(/\/s$/, "");
  const match = cleaned.match(/^([\d.]+)\s*(kb|mb|gb|k|m|g|b)?$/);
  if (!match) return 0;

  const value = parseFloat(match[1]!);
  const unit = match[2] || "b";

  switch (unit) {
    case "gb":
    case "g":
      return Math.round(value * 1024 * 1024 * 1024);
    case "mb":
    case "m":
      return Math.round(value * 1024 * 1024);
    case "kb":
    case "k":
      return Math.round(value * 1024);
    case "b":
    default:
      return Math.round(value);
  }
}

export const defaultBandwidthLimiter = new TokenBucketLimiter(
  parseBandwidthString(process.env.DELTASYNC_MAX_BANDWIDTH),
);
