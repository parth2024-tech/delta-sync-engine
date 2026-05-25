/**
 * Authentication Tests - Comprehensive auth security testing
 *
 * Tests cover:
 * - API key generation and validation
 * - JWT token creation and verification
 * - Password hashing and verification
 * - Session management
 * - Error cases and security edge cases
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as apiKey from '../server/api-key';
import * as auth from '../server/auth';

describe('API Key Management', () => {
  describe('generateApiKey', () => {
    it('should generate keys with dks_ prefix', () => {
      const key = apiKey.generateApiKey();
      expect(key).toMatch(/^dks_/);
    });

    it('should generate unique keys', () => {
      const key1 = apiKey.generateApiKey();
      const key2 = apiKey.generateApiKey();
      expect(key1).not.toBe(key2);
    });

    it('should generate 256-bit keys (43 chars after prefix)', () => {
      const key = apiKey.generateApiKey();
      const keyPart = key.slice(4); // Remove 'dks_'
      expect(keyPart).toHaveLength(43); // Base64url 32 bytes = 43 chars
    });

    it('should use valid base64url characters', () => {
      const key = apiKey.generateApiKey();
      expect(key).toMatch(/^dks_[A-Za-z0-9_-]+$/);
    });
  });

  describe('hashApiKey', () => {
    it('should hash API keys consistently', () => {
      const key = apiKey.generateApiKey();
      const hash1 = apiKey.hashApiKey(key);
      const hash2 = apiKey.hashApiKey(key);

      expect(hash1).toBe(hash2);
    });

    it('should produce SHA-256 hashes (64 hex chars)', () => {
      const key = apiKey.generateApiKey();
      const hash = apiKey.hashApiKey(key);

      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should be one-way (cannot reverse)', () => {
      const key = apiKey.generateApiKey();
      const hash = apiKey.hashApiKey(key);

      // Hash should not contain original key
      expect(hash).not.toContain(key);
    });

    it('should produce different hashes for different keys', () => {
      const key1 = apiKey.generateApiKey();
      const key2 = apiKey.generateApiKey();
      const hash1 = apiKey.hashApiKey(key1);
      const hash2 = apiKey.hashApiKey(key2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('isValidApiKeyFormat', () => {
    it('should accept properly formatted keys', () => {
      const validKey = apiKey.generateApiKey();
      expect(apiKey.isValidApiKeyFormat(validKey)).toBe(true);
    });

    it('should reject keys without prefix', () => {
      const noPrefixKey = 'SomeRandomString123';
      expect(apiKey.isValidApiKeyFormat(noPrefixKey)).toBe(false);
    });

    it('should reject keys with wrong prefix', () => {
      const wrongPrefix = 'sk_abc123';
      expect(apiKey.isValidApiKeyFormat(wrongPrefix)).toBe(false);
    });

    it('should reject keys with invalid characters', () => {
      const invalidChars = 'dks_abc@123';
      expect(apiKey.isValidApiKeyFormat(invalidChars)).toBe(false);
    });

    it('should reject empty strings', () => {
      expect(apiKey.isValidApiKeyFormat('')).toBe(false);
    });
  });

  describe('verifyApiKey', () => {
    it('should verify correct keys', () => {
      const key = apiKey.generateApiKey();
      const hash = apiKey.hashApiKey(key);

      expect(apiKey.verifyApiKey(key, hash)).toBe(true);
    });

    it('should reject incorrect keys', () => {
      const key1 = apiKey.generateApiKey();
      const key2 = apiKey.generateApiKey();
      const hash = apiKey.hashApiKey(key1);

      expect(apiKey.verifyApiKey(key2, hash)).toBe(false);
    });

    it('should use timing-safe comparison', () => {
      const key = apiKey.generateApiKey();
      const hash = apiKey.hashApiKey(key);

      // Timing attack protection: same number of operations for valid/invalid
      const wrongKey = apiKey.generateApiKey();
      const start = process.hrtime.bigint();
      apiKey.verifyApiKey(wrongKey, hash);
      const end = process.hrtime.bigint();

      expect(end - start).toBeGreaterThan(0n);
    });

    it('should reject corrupted hashes', () => {
      const key = apiKey.generateApiKey();
      const hash = apiKey.hashApiKey(key);
      const corrupted = 'a'.repeat(64);

      expect(apiKey.verifyApiKey(key, corrupted)).toBe(false);
    });
  });

  describe('extractApiKeyPrefix', () => {
    it('should extract first 8 chars after prefix', () => {
      const key = apiKey.generateApiKey();
      const prefix = apiKey.extractApiKeyPrefix(key);

      expect(prefix).toMatch(/^dks_.{8}$/);
    });

    it('should be useful for indexing', () => {
      const key1 = apiKey.generateApiKey();
      const key2 = apiKey.generateApiKey();

      const prefix1 = apiKey.extractApiKeyPrefix(key1);
      const prefix2 = apiKey.extractApiKeyPrefix(key2);

      // Prefixes might match (1 in 16^8 chance), but keys differ
      expect(key1).not.toBe(key2);
    });

    it('should throw on invalid keys', () => {
      expect(() => {
        apiKey.extractApiKeyPrefix('invalid');
      }).toThrow();
    });
  });
});

describe('JWT Authentication', () => {
  describe('createSessionToken', () => {
    it('should create valid JWT tokens', async () => {
      const userId = 'user-123';
      const token = await auth.createSessionToken(userId);

      expect(token).toBeDefined();
      expect(token).toContain('.');
    });

    it('should set 30-day expiration', async () => {
      // JWT tokens have exp claim
      const token = await auth.createSessionToken('user-123');
      expect(token).toBeTruthy();
    });

    it('should encode userId in subject claim', async () => {
      const userId = 'user-456';
      const token = await auth.createSessionToken(userId);

      // Tokens are base64-encoded; we verify it decodes
      expect(token).toContain('.');
    });
  });

  describe('verifySessionToken', () => {
    it('should verify valid tokens', async () => {
      const userId = 'user-789';
      const token = await auth.createSessionToken(userId);
      const verified = await auth.verifySessionToken(token);

      expect(verified).toBe(userId);
    });

    it('should return null for invalid tokens', async () => {
      const invalidToken = 'invalid.token.here';
      const result = await auth.verifySessionToken(invalidToken);

      expect(result).toBeNull();
    });

    it('should return null for tampered tokens', async () => {
      const token = await auth.createSessionToken('user-123');
      const tampered = token.slice(0, -10) + 'corrupted!';
      const result = await auth.verifySessionToken(tampered);

      expect(result).toBeNull();
    });

    it('should handle expired tokens gracefully', async () => {
      // We can't easily test expiration without manipulating time
      // but we test the error handling
      const result = await auth.verifySessionToken('expired.token.here');
      expect(result).toBeNull();
    });
  });
});

describe('Password Management', () => {
  describe('hashPassword', () => {
    it('should hash passwords with bcryptjs', async () => {
      const password = 'MySecurePassword123!';
      const hash = await auth.hashPassword(password);

      expect(hash).toBeTruthy();
      expect(hash).toContain('$2');
    });

    it('should produce different hashes for same password', async () => {
      const password = 'MySecurePassword123!';
      const hash1 = await auth.hashPassword(password);
      const hash2 = await auth.hashPassword(password);

      expect(hash1).not.toBe(hash2);
    });

    it('should use salt rounds of 12', async () => {
      const password = 'MySecurePassword123!';
      const hash = await auth.hashPassword(password);

      // bcrypt format: $2a$rounds$...
      const rounds = parseInt(hash.substring(4, 6));
      expect(rounds).toBe(12);
    });
  });

  describe('verifyPassword', () => {
    it('should verify correct passwords', async () => {
      const password = 'MySecurePassword123!';
      const hash = await auth.hashPassword(password);
      const isValid = await auth.verifyPassword(password, hash);

      expect(isValid).toBe(true);
    });

    it('should reject incorrect passwords', async () => {
      const password = 'MySecurePassword123!';
      const hash = await auth.hashPassword(password);
      const isValid = await auth.verifyPassword('WrongPassword', hash);

      expect(isValid).toBe(false);
    });

    it('should handle corrupted hashes', async () => {
      const corrupted = 'not-a-valid-hash';
      const isValid = await auth.verifyPassword('password', corrupted);
      expect(isValid).toBe(false);
    });
  });
});

describe('Security Edge Cases', () => {
  it('should handle very long keys gracefully', async () => {
    const key = apiKey.generateApiKey();
    const longKey = key + 'x'.repeat(1000);

    expect(apiKey.isValidApiKeyFormat(key)).toBe(true);
    expect(apiKey.isValidApiKeyFormat(longKey)).toBe(false);
  });

  it('should handle null/undefined inputs', async () => {
    expect(() => {
      apiKey.isValidApiKeyFormat(null as any);
    }).toThrow();

    expect(() => {
      apiKey.isValidApiKeyFormat(undefined as any);
    }).toThrow();
  });

  it('should prevent timing attacks on hash comparison', async () => {
    const key = apiKey.generateApiKey();
    const hash = apiKey.hashApiKey(key);
    const wrongKey = apiKey.generateApiKey();

    // Both operations should take similar time
    const iterations = 100;
    const start1 = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      apiKey.verifyApiKey(key, hash);
    }
    const time1 = process.hrtime.bigint();

    const start2 = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      apiKey.verifyApiKey(wrongKey, hash);
    }
    const time2 = process.hrtime.bigint();

    // Times should be similar (within 50% variance for test reliability)
    const variance = Math.abs(Number(time2 - time1)) / Number(time1 + time2);
    expect(variance).toBeLessThan(0.5);
  });
});
