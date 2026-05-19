/**
 * In-memory rate limiter for Lite Mode MVP.
 *
 * Provides:
 *   - checkRateLimit:          60 req/min for uploads/negotiate
 *   - checkDownloadRateLimit:  30 req/min for downloads
 *   - checkByteQuota:          500 MB/min download byte quota
 *
 * Configurable via environment variables:
 *   - RATE_LIMIT_UPLOAD:    max upload requests per minute (default: 60)
 *   - RATE_LIMIT_DOWNLOAD:  max download requests per minute (default: 30)
 *   - BYTE_QUOTA_MB:        max download MB per minute (default: 500)
 */

const uploadLimits = new Map<string, { count: number; expiresAt: number }>();
const downloadLimits = new Map<string, { count: number; expiresAt: number }>();
const byteLimits = new Map<string, { bytes: number; expiresAt: number }>();

const MAX_UPLOAD_RPM = Math.max(1, parseInt(process.env.RATE_LIMIT_UPLOAD || "60", 10) || 60);
const MAX_DOWNLOAD_RPM = Math.max(1, parseInt(process.env.RATE_LIMIT_DOWNLOAD || "30", 10) || 30);
const MAX_BYTE_QUOTA = Math.max(1, parseInt(process.env.BYTE_QUOTA_MB || "500", 10) || 500) * 1024 * 1024;

const WINDOW_MS = 60_000; // 60-second sliding window

/** Rate limit for upload/negotiate endpoints: 60 req/min per user. */
export async function checkRateLimit(userId: string): Promise<boolean> {
  return _checkRequestLimit(uploadLimits, `upload:${userId}`, MAX_UPLOAD_RPM);
}

/** Rate limit for download endpoint: 30 req/min per user. */
export function checkDownloadRateLimit(userId: string): boolean {
  return _checkRequestLimit(downloadLimits, `download:${userId}`, MAX_DOWNLOAD_RPM);
}

/** Byte quota for download endpoint: 500 MB/min per user. */
export function checkByteQuota(userId: string, bytes: number): boolean {
  const key = `bytes:${userId}`;
  const now = Date.now();
  const entry = byteLimits.get(key);

  if (!entry || entry.expiresAt < now) {
    byteLimits.set(key, { bytes, expiresAt: now + WINDOW_MS });
    return true;
  }

  if (entry.bytes + bytes <= MAX_BYTE_QUOTA) {
    entry.bytes += bytes;
    return true;
  }

  return false;
}

function _checkRequestLimit(
  map: Map<string, { count: number; expiresAt: number }>,
  key: string,
  max: number,
): boolean {
  const now = Date.now();
  const entry = map.get(key);

  if (!entry || entry.expiresAt < now) {
    map.set(key, { count: 1, expiresAt: now + WINDOW_MS });
    return true;
  }

  if (entry.count < max) {
    entry.count += 1;
    return true;
  }

  return false;
}

// Cleanup expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const map of [uploadLimits, downloadLimits, byteLimits]) {
    for (const [key, entry] of (map as Map<string, { expiresAt: number }>).entries()) {
      if (entry.expiresAt < now) {
        map.delete(key);
      }
    }
  }
}, 60000).unref();
