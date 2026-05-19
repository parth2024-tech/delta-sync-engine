// In-memory token bucket / rate limiter for Lite Mode MVP

const limits = new Map<string, { count: number; expiresAt: number }>();

export async function checkRateLimit(userId: string): Promise<boolean> {
  const key = `rate_limit:${userId}`;
  const now = Date.now();
  const entry = limits.get(key);

  if (!entry || entry.expiresAt < now) {
    // New entry or expired
    limits.set(key, { count: 1, expiresAt: now + 60000 }); // 60s window
    return true;
  }

  if (entry.count < 60) {
    entry.count += 1;
    return true;
  }

  return false;
}

// Cleanup expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of limits.entries()) {
    if (entry.expiresAt < now) {
      limits.delete(key);
    }
  }
}, 60000).unref();
