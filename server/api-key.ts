/**
 * Secure API key generation and management.
 *
 * Features:
 * - 256-bit cryptographically secure keys (not just UUIDs)
 * - Standardized prefix format (dks_ for DeltaSync)
 * - Safe hashing with SHA-256 for storage
 * - Proper validation and prefix checking
 */

import crypto from "crypto";

const KEY_PREFIX = "dks_";
const KEY_BYTES = 32; // 256 bits
const STORED_PREFIX_LENGTH = 8; // First 8 chars after prefix for indexing

/**
 * Generate a new secure API key with proper format.
 * Returns the full key (only shown once to user).
 * Store only the hash in the database.
 */
export function generateApiKey(): string {
  const randomBytes = crypto.randomBytes(KEY_BYTES);
  const base64 = randomBytes.toString("base64url");
  return `${KEY_PREFIX}${base64}`;
}

/**
 * Hash an API key for storage.
 * Use SHA-256 for fast verification without compromising security.
 */
export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

/**
 * Validate API key format.
 * Returns true if key matches the expected format.
 */
export function isValidApiKeyFormat(key: string): boolean {
  if (!key.startsWith(KEY_PREFIX)) return false;
  const keyPart = key.slice(KEY_PREFIX.length);
  // Base64url for 32 bytes is exactly 43 characters (A-Z, a-z, 0-9, -, _)
  return /^[A-Za-z0-9_-]{43}$/.test(keyPart);
}

/**
 * Extract the prefix from an API key for indexing.
 * Use this to find potential matching keys in the database.
 */
export function extractApiKeyPrefix(key: string): string {
  if (!isValidApiKeyFormat(key)) throw new Error("Invalid API key format");
  const keyPart = key.slice(KEY_PREFIX.length);
  return KEY_PREFIX + keyPart.slice(0, STORED_PREFIX_LENGTH);
}

/**
 * Verify an API key against its stored hash.
 * Always use constant-time comparison to prevent timing attacks.
 */
export function verifyApiKey(key: string, storedHash: string): boolean {
  const hash = hashApiKey(key);
  return crypto.timingSafeEqual(
    Buffer.from(hash),
    Buffer.from(storedHash),
  );
}
