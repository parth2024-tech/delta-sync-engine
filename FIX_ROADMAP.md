# Deltasync Fix Prioritization Roadmap

## Overview

**Total Effort:** ~8-9 weeks | **Risk Reduction:** 95%
- Phase 1 (Critical): 2 weeks
- Phase 2 (Hardening): 2 weeks  
- Phase 3 (Quality): 3-4 weeks

---

## 🔴 PHASE 1: CRITICAL (BLOCKING RELEASE)

**Duration:** ~2 weeks | **Effort:** 7.5 days  
**Blocks:** All releases until complete  
**Impact:** Eliminates 25% of critical vulnerabilities

### Fix-001: Add Input Path Validation
**Effort:** 2 days | **Files:** `cli/src/index.ts`, `cli/src/push.ts`

**Why First:**
- Blocks path traversal attacks
- Enables other fixes to trust file paths
- Must be done before any file I/O improvements

**Implementation:**
```typescript
// Add to cli/src/validation.ts
import { realpathSync } from 'fs';
import path from 'path';

export function validateFilePath(filePath: string, maxSizeBytes = 10 * 1024 * 1024 * 1024): string {
  // 1. Resolve symlinks & normalize
  const canonical = realpathSync(filePath);
  
  // 2. Reject if outside project root
  const cwd = process.cwd();
  if (!canonical.startsWith(cwd)) {
    throw new Error(`File must be inside current directory: ${cwd}`);
  }
  
  // 3. Check file exists & is readable
  const stat = statSync(canonical);
  if (!stat.isFile()) throw new Error(`Not a file: ${canonical}`);
  
  // 4. Enforce max size
  if (stat.size > maxSizeBytes) {
    throw new Error(`File too large: ${stat.size} > ${maxSizeBytes}`);
  }
  
  return canonical;
}
```

**Testing:**
- ✅ Reject `../../../etc/passwd`
- ✅ Reject symlink to `/etc/hosts`
- ✅ Accept valid local file
- ✅ Reject non-existent file
- ✅ Reject > 10GB file

---

### Fix-002: Secure Credential Storage
**Effort:** 3 days | **Files:** `cli/src/config.ts`, `cli/src/index.ts`  
**Depends on:** Fix-001

**Why:**
- Prevents API key theft via filesystem access
- Required before any production deployment
- Reduces attack surface significantly

**Implementation Strategy:**

Option A: OS Keychain (Recommended)
```bash
npm install keytar
```

```typescript
// cli/src/keychain.ts
import keytar from 'keytar';

export async function saveCredential(service: string, apiKey: string) {
  try {
    await keytar.setPassword(service, 'api-key', apiKey);
    return true;
  } catch {
    // Fallback to encrypted file
    return saveEncryptedConfig(apiKey);
  }
}

export async function getCredential(service: string): Promise<string | null> {
  try {
    return await keytar.getPassword(service, 'api-key');
  } catch {
    return getEncryptedConfig();
  }
}
```

Option B: Fallback - Encrypted .env
```typescript
// Fallback if keytar unavailable
import crypto from 'crypto';

function encryptKey(apiKey: string, machineId: string): string {
  const cipher = crypto.createCipher('aes-256-cbc', machineId);
  return cipher.update(apiKey, 'utf8', 'hex') + cipher.final('hex');
}

function decryptKey(encrypted: string, machineId: string): string {
  const decipher = crypto.createDecipher('aes-256-cbc', machineId);
  return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
}
```

**Testing:**
- ✅ Save & retrieve credential from keychain
- ✅ Fallback to encrypted file on older Node
- ✅ File permissions on .env (600)
- ✅ Reject plaintext in git (add to .gitignore)

**Files Changed:**
- `cli/src/config.ts` → Use new credential store
- `cli/src/index.ts` → Remove plaintext in init
- `.gitignore` → Ensure .deltasync/.env is ignored

---

### Fix-003: Fix Concurrency Race Condition
**Effort:** 2.5 days | **Files:** `cli/src/push.ts`  
**Depends on:** Fix-001

**Why:**
- Silent upload failures are critical
- Can cause duplicate chunks in S3
- Breaks upload resumption

**Current Problem:**
```typescript
let activeCount = 0;      // ← Not atomic
let activeLimit = 8;      // ← Races with concurrent reads

const runWorker = async () => {
  activeCount++;          // ← Two workers both ++, should be 2, might be 1
  try {
    while (index < uploadsWithMetadata.length && !uploadError) {
      if (activeCount > activeLimit) break;  // ← Might read stale
      const chunk = uploadsWithMetadata[index++];  // ← RACE: two workers read same index
```

**Solution: Use Semaphore Pattern**
```typescript
class Semaphore {
  private count: number;
  private waitQueue: (() => void)[] = [];

  constructor(initialCount: number) {
    this.count = initialCount;
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return;
    }
    return new Promise(resolve => this.waitQueue.push(resolve));
  }

  release(): void {
    if (this.waitQueue.length > 0) {
      this.waitQueue.shift()?.();
    } else {
      this.count++;
    }
  }
}

// Usage in push.ts
const semaphore = new Semaphore(UPLOAD_CONCURRENCY);

for (const chunk of remainingUploads) {
  (async () => {
    await semaphore.acquire();
    try {
      await uploadChunk(chunk);
    } finally {
      semaphore.release();
    }
  })();
}
```

**Testing:**
- ✅ Upload 100 chunks with concurrency 5 → exactly 5 concurrent
- ✅ No duplicate uploads
- ✅ All chunks eventually complete
- ✅ Error in one chunk doesn't affect others

---

## 🟠 PHASE 2: HARDENING (PRODUCTION USE)

**Duration:** ~2 weeks | **Effort:** 8 days  
**Blocks:** Production deployment  
**Impact:** Eliminates 25% of high-severity issues

### Fix-004: Add HTTP Request Timeouts
**Effort:** 1 day | **Files:** `cli/src/api.ts`  
**Depends on:** Fix-001

**Problem:**
```typescript
const r = await fetch(url, { ... });
// ← Can hang forever if server doesn't respond
```

**Solution:**
```typescript
// cli/src/api-client.ts
export class ApiClient {
  private readonly timeout: number;

  constructor(serverUrl: string, apiKey: string, timeoutMs = 30000) {
    this.timeout = timeoutMs;
  }

  async fetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(endpoint, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return response;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new NetworkError(`Request timeout (${this.timeout}ms)`);
      }
      throw err;
    }
  }
}
```

**Testing:**
- ✅ 30s timeout triggers on slow server
- ✅ Fast requests complete normally
- ✅ Timeout error is distinguishable from network error

---

### Fix-005: Centralized Error Handling
**Effort:** 4 days | **Files:** `cli/src/api.ts`, `cli/src/index.ts`  
**Depends on:** Fix-004

**Create Error Hierarchy:**
```typescript
// cli/src/errors.ts
export class DeltasyncError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'DeltasyncError';
  }
}

export class NetworkError extends DeltasyncError {
  constructor(message: string) {
    super(message, 'NETWORK_ERROR');
  }
}

export class AuthError extends DeltasyncError {
  constructor(message: string) {
    super(message, 'AUTH_ERROR');
  }
}

export class ValidationError extends DeltasyncError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
  }
}

export class ServerError extends DeltasyncError {
  constructor(message: string, public statusCode: number) {
    super(message, 'SERVER_ERROR');
  }
}

export class FileTooLargeError extends DeltasyncError {
  constructor(size: number, max: number) {
    super(`File size ${size} exceeds limit ${max}`, 'FILE_TOO_LARGE');
  }
}
```

**Map HTTP errors:**
```typescript
// In api.ts
async function handleResponse(r: Response, context: string) {
  if (r.ok) return r;

  const body = await r.text();

  if (r.status === 401) {
    throw new AuthError('Invalid API key. Run: deltasync init');
  }
  if (r.status === 429) {
    throw new NetworkError('Server rate limited. Wait before retrying.');
  }
  if (r.status === 413) {
    throw new FileTooLargeError(/* ... */);
  }
  if (r.status >= 500) {
    throw new ServerError(`Server error (${r.status}): ${body}`, r.status);
  }
  throw new Error(`${context} failed: HTTP ${r.status}`);
}
```

**User-Friendly CLI Output:**
```typescript
// In index.ts
try {
  await performPush(filePath, cfg);
} catch (err) {
  if (err instanceof AuthError) {
    console.error('🔑 Authentication failed:');
    console.error(`   ${err.message}`);
    console.error('   Fix: Run `deltasync init` with correct API key');
  } else if (err instanceof FileTooLargeError) {
    console.error('📁 File too large:');
    console.error(`   ${err.message}`);
    console.error('   Tip: Use --chunk-size to split into smaller uploads');
  } else if (err instanceof NetworkError) {
    console.error('🌐 Network error:');
    console.error(`   ${err.message}`);
    console.error('   Check: Server URL and internet connection');
  } else {
    console.error('❌ Unexpected error:', err.message);
  }
  process.exit(1);
}
```

---

### Fix-006: Strengthen Database Schema
**Effort:** 3 days | **Files:** `cli/src/db.ts`  
**Depends on:** Fix-001

**Current Issues:**
```sql
CREATE TABLE files (
  path TEXT PRIMARY KEY,
  last_mtime REAL NOT NULL,        -- Ambiguous type
  last_size INTEGER NOT NULL,
  last_hash TEXT NOT NULL,          -- No unique constraint?
  server_version INTEGER NOT NULL,
  last_accessed INTEGER NOT NULL    -- No validation
);
```

**Enhanced Schema:**
```typescript
// cli/src/db.ts
db.exec(`
  -- Drop and recreate with constraints
  DROP TABLE IF EXISTS files;
  DROP TABLE IF EXISTS chunk_transfers;
  DROP TABLE IF EXISTS negotiation_sessions;

  CREATE TABLE files (
    path TEXT PRIMARY KEY,
    last_mtime_ms INTEGER NOT NULL CHECK (last_mtime_ms >= 0),
    last_size INTEGER NOT NULL CHECK (last_size >= 0),
    last_hash TEXT NOT NULL,
    server_version INTEGER NOT NULL CHECK (server_version >= 0),
    last_accessed_ms INTEGER NOT NULL CHECK (last_accessed_ms >= 0),
    created_at_ms INTEGER NOT NULL DEFAULT (unixepoch('now', 'milliseconds'))
  );
  
  CREATE INDEX idx_files_last_accessed ON files(last_accessed_ms);
  CREATE INDEX idx_files_last_hash ON files(last_hash);

  CREATE TABLE chunk_transfers (
    negotiation_id TEXT NOT NULL,
    strong_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
    created_at_ms INTEGER NOT NULL DEFAULT (unixepoch('now', 'milliseconds')),
    PRIMARY KEY (negotiation_id, strong_hash),
    FOREIGN KEY (negotiation_id) REFERENCES negotiation_sessions(negotiation_id) ON DELETE CASCADE
  );

  CREATE TABLE negotiation_sessions (
    negotiation_id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL DEFAULT (unixepoch('now', 'milliseconds')),
    FOREIGN KEY (path) REFERENCES files(path) ON DELETE CASCADE
  );
  
  CREATE INDEX idx_negotiation_sessions_path ON negotiation_sessions(path);
`);
```

**Add Migration Support:**
```typescript
const SCHEMA_VERSION = 2;
const dbVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };

if (dbVersion.user_version < SCHEMA_VERSION) {
  console.log(`Migrating database from v${dbVersion.user_version} to v${SCHEMA_VERSION}...`);
  db.exec(/* migration SQL */);
  db.prepare(`PRAGMA user_version = ${SCHEMA_VERSION}`).run();
  console.log('✓ Migration complete');
}
```

---

## 🟡 PHASE 3: QUALITY (BEFORE v1.0)

**Duration:** ~3-4 weeks | **Effort:** 8 days  
**Blocks:** v1.0 release  
**Impact:** Improves reliability and maintainability

### Fix-007: Structured Logging
**Effort:** 1.5 days | **Files:** All CLI files

**Replace console.log with structured logging:**
```bash
npm install winston
```

```typescript
// cli/src/logger.ts
import winston from 'winston';

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'deltasync-cli' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp }) => 
          `${timestamp} [${level}] ${message}`
        )
      )
    })
  ]
});
```

**Usage:**
```typescript
// Before:
console.log(`Uploading ${remainingUploads.length} chunks...`);
console.warn(`Failed to upload chunk: ${err.message}`);

// After:
logger.info('Uploading chunks', { count: remainingUploads.length, negotiationId });
logger.error('Failed to upload chunk', { 
  strongHash: chunk.strongHash, 
  error: err.message,
  attempts: 3,
  negotiationId 
});
```

---

### Fix-008: Add Retry Jitter
**Effort:** 1 day | **Files:** `cli/src/push.ts`  
**Depends on:** Fix-004

```typescript
// Replace basic exponential backoff
const calculateBackoff = (attempt: number, maxWait = 60000): number => {
  const exponential = Math.min(1000 * Math.pow(2, attempt), maxWait);
  const jitter = Math.random() * 1000;
  return exponential + jitter;
};

// Respect Retry-After header
const getRetryDelay = (response: Response): number => {
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter) {
    const delaySeconds = parseInt(retryAfter);
    return !isNaN(delaySeconds) ? delaySeconds * 1000 : calculateBackoff(attempt);
  }
  return calculateBackoff(attempt);
};
```

---

### Fix-009: Fix Type Safety Gaps
**Effort:** 1.5 days | **Files:** `cli/src/db.ts`

```typescript
// Replace all 'as any' with proper types

interface FileRow {
  path: string;
  last_mtime_ms: number;
  last_size: number;
  last_hash: string;
  server_version: number;
  last_accessed_ms: number;
}

interface NegotiationSessionRow {
  negotiation_id: string;
  path: string;
  content_sha256: string;
}

// Type-safe queries
export function getNegotiationSession(filePath: string): NegotiationSessionRow | undefined {
  return db.prepare(
    "SELECT negotiation_id, path, content_sha256 FROM negotiation_sessions WHERE path = ?"
  ).get(filePath) as NegotiationSessionRow | undefined;
}
```

---

### Fix-010: Add Upload Compression
**Effort:** 1.5 days | **Files:** `cli/src/api.ts`, `cli/src/push.ts`  
**Depends on:** Fix-005

```bash
npm install zlib  # Built-in, no install needed
```

```typescript
// cli/src/compression.ts
import { gzipSync } from 'zlib';

export function compressIfBeneficial(data: Buffer): { data: Buffer; compressed: boolean } {
  if (data.length < 1024 * 1024) {
    // Skip compression for files < 1MB
    return { data, compressed: false };
  }

  const compressed = gzipSync(data, { level: 6 }); // Balance speed/ratio
  
  if (compressed.length >= data.length * 0.95) {
    // Only use if > 5% savings
    return { data, compressed: false };
  }

  logger.info('Compressing literals', { 
    original: data.length, 
    compressed: compressed.length,
    ratio: (compressed.length / data.length).toFixed(2)
  });
  
  return { data: compressed, compressed: true };
}
```

**Update API to decompress:**
```typescript
export async function upload(
  cfg: Config,
  meta: UploadMetaJson & { literalsCompressed?: boolean },
  literalBytes: Buffer,
) {
  const { data: compressedData, compressed } = compressIfBeneficial(literalBytes);
  
  form.append('meta', JSON.stringify({
    ...meta,
    literalsCompressed: compressed
  }));
  form.append('literals', new Blob([compressedData]));
}
```

---

### Fix-011: Add CLI Unit Tests
**Effort:** 3.5 days | **Files:** `cli/**/*.test.ts`  
**Depends on:** Fix-005, Fix-006

**Test Suite Structure:**
```typescript
// cli/__tests__/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { saveConfig, readConfig } from '../src/config';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import path from 'path';

describe('Config Management', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync('/tmp/deltasync-test-');
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir('/');
    rmSync(tempDir, { recursive: true });
  });

  it('saves and retrieves config securely', async () => {
    const config = { serverUrl: 'http://localhost:5000', apiKey: 'dks_test' };
    await saveConfig(config);
    
    const retrieved = await readConfig();
    expect(retrieved.apiKey).toBe('dks_test');
  });

  it('rejects plaintext config.json', () => {
    const plaintext = JSON.stringify({ apiKey: 'dks_secret' });
    writeFileSync('.deltasync/config.json', plaintext);
    
    expect(() => readConfig()).toThrow('Corrupted config');
  });
});

// cli/__tests__/push.test.ts
describe('Push Logic', () => {
  it('validates file path before pushing', async () => {
    expect(() => performPush('../../../etc/passwd', cfg)).rejects.toThrow('outside current directory');
  });

  it('skips unchanged files', async () => {
    // File with same hash in cache
    const result = await performPush('unchanged.txt', cfg);
    expect(result.bytesSaved).toBe(0);
  });

  it('retries on network errors', async () => {
    // Mock S3 returning 503
    mockS3.on(503, { retryAfter: 1 });
    
    const result = await performPush('large.bin', cfg);
    expect(result.versionNo).toBeGreaterThan(0);
  });
});
```

**Add Vitest configuration:**
```typescript
// cli/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', '__tests__/'],
      all: true,
      lines: 80,
      functions: 80,
      branches: 80,
    }
  }
});
```

---

### Fix-012: Validate Environment Variables
**Effort:** 0.5 days | **Files:** `cli/src/index.ts`, `cli/src/rsync.ts`

```typescript
// cli/src/env-validation.ts
export function validateEnv() {
  // DELTASYNC_CONCURRENCY
  const concurrency = process.env.DELTASYNC_CONCURRENCY;
  if (concurrency) {
    const num = parseInt(concurrency, 10);
    if (isNaN(num) || num < 1 || num > 32) {
      throw new Error(
        `Invalid DELTASYNC_CONCURRENCY="${concurrency}". ` +
        `Must be an integer between 1 and 32.`
      );
    }
  }

  // DELTASYNC_NATIVE
  const nativePath = process.env.DELTASYNC_NATIVE;
  if (nativePath && !fs.existsSync(nativePath)) {
    throw new Error(
      `DELTASYNC_NATIVE="${nativePath}" does not exist. ` +
      `Unset the variable to use auto-detection.`
    );
  }

  // OP_BIN_THRESHOLD
  const threshold = process.env.OP_BIN_THRESHOLD;
  if (threshold) {
    const num = parseInt(threshold, 10);
    if (isNaN(num) || num <= 0) {
      throw new Error(
        `Invalid OP_BIN_THRESHOLD="${threshold}". ` +
        `Must be a positive integer.`
      );
    }
  }
}

// Call at startup
validateEnv();
```

---

## Timeline & Dependencies

```
Phase 1 (Weeks 1-2)
├─ fix-001: Path validation (2d)
├─ fix-002: Credentials (3d) [depends: 001]
└─ fix-003: Concurrency (2.5d) [depends: 001]

Phase 2 (Weeks 3-4)
├─ fix-004: Timeouts (1d)
├─ fix-005: Error handling (4d) [depends: 004]
└─ fix-006: DB schema (3d) [depends: 001]

Phase 3 (Weeks 5-8)
├─ fix-007: Logging (1.5d)
├─ fix-008: Retry jitter (1d) [depends: 004]
├─ fix-009: Type safety (1.5d)
├─ fix-010: Compression (1.5d) [depends: 005]
├─ fix-011: CLI tests (3.5d) [depends: 005, 006]
└─ fix-012: Env validation (0.5d)
```

---

## Success Criteria

### Phase 1 Complete:
- [ ] All file paths resolved with `realpath()`, symlinks rejected
- [ ] API keys stored in OS keychain (or encrypted fallback)
- [ ] Concurrent uploads use semaphore, no duplicate chunks
- [ ] Security audit passes for these three areas
- [ ] Integration tests pass

### Phase 2 Complete:
- [ ] All fetch calls have 30s timeout
- [ ] HTTP errors mapped to custom error classes
- [ ] Database schema has constraints + indexes + foreign keys
- [ ] Migration versioning works
- [ ] All API calls wrapped with typed error handling
- [ ] User-friendly error messages on CLI

### Phase 3 Complete:
- [ ] All console.log() replaced with structured logging
- [ ] Retry backoff includes jitter + respects Retry-After
- [ ] Zero `as any` type assertions in code
- [ ] Large uploads use gzip compression
- [ ] CLI module has 80% test coverage
- [ ] Environment variables validated on startup
- [ ] v1.0 release ready

---

## Effort Summary

| Phase | Effort | Blocks | Priority |
|-------|--------|--------|----------|
| Phase 1 | 7.5d | Release | 🔴 CRITICAL |
| Phase 2 | 8d | Production | 🟠 HIGH |
| Phase 3 | 8d | v1.0 | 🟡 MEDIUM |
| **Total** | **~4-5 weeks** | - | - |

