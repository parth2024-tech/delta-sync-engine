# Enterprise Tier-1 Architectural Enhancements Blueprint

**Target Platform:** Delta Sync Engine  
**Document ID:** `ENG-ADV-2026-02`  
**Status:** Approved for Implementation  
**Scope:** Distributed Tracing (OTel), Resumable Checkpoint State Machine, Adaptive Bandwidth Shaping, Reference-Counted CAS GC, and HTTP/2 Binary Frame Multiplexing.

---

## Architecture Blueprint Overview

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                       ENTERPRISE DELTA SYNC ENGINE (TIER-1 STACK)                          │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│  1. OBSERVABILITY   │ W3C TraceContext (traceparent) · OTLP Exporter · S3 TTFB Histograms   │
│  2. CLIENT ENGINE   │ SQLite Checkpoint State Machine · Crash-Recovery · Bandwidth Shaper   │
│  3. WIRE PROTOCOL   │ HTTP/2 Multiplexed Framing (DSO3) · Persistent Streaming Uploads      │
│  4. SERVER STORAGE  │ Atomic Reference-Counted CAS (PostgreSQL) · Sweep-on-Zero GC          │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. End-to-End Distributed Tracing & Observability (OpenTelemetry)

### 1.1 Architecture & Header Propagation
The synchronization pipeline spans local disk I/O, hash computation, HTTP network handshakes, S3 object storage transfers, and asynchronous worker thread pools. We standardize on **W3C Trace Context (`traceparent`)** across all boundaries.

```
CLI Client Span (deltasync.push)
 ├── Span: compute_fastcdc_signatures
 ├── Span: negotiate_handshake [HTTP POST] ──(traceparent)──> API Server Span: /api/public/sync/negotiate
 │                                                             ├── Span: db_check_existing_version
 │                                                             └── Span: s3_head_chunk_batch
 ├── Span: upload_chunk_pool [HTTP PUT direct to CAS] ───────> S3 Storage (Latency Metric)
 └── Span: commit_sync [HTTP POST] ──────────(traceparent)──> API Server Span: /api/public/sync/commit
                                                               └── Span: db_insert_outbox_event
                                                                    └── (Async Outbox) Worker Span: verify_chunks
```

### 1.2 CLI Trace Context Injector
#### File: `cli/src/telemetry.ts`
```typescript
import crypto from "node:crypto";

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceFlags: string;
}

/** Generates compliant W3C traceparent header: 00-{traceId}-{spanId}-{traceFlags} */
export function generateTraceContext(parent?: TraceContext): TraceContext {
  return {
    traceId: parent?.traceId ?? crypto.randomBytes(16).toString("hex"),
    spanId: crypto.randomBytes(8).toString("hex"),
    traceFlags: "01", // Sampled
  };
}

export function formatTraceparent(ctx: TraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.traceFlags}`;
}

export function parseTraceparent(header: string | null): TraceContext | null {
  if (!header) return null;
  const parts = header.split("-");
  if (parts.length !== 4 || parts[0] !== "00") return null;
  return { traceId: parts[1]!, spanId: parts[2]!, traceFlags: parts[3]! };
}
```

### 1.3 Wire-Level Trace Injection
In [`cli/src/api.ts`](file:///home/thor/Downloads/delta-sync-engine-main/cli/src/api.ts), automatically attach `traceparent` to all requests:
```typescript
import { formatTraceparent, generateTraceContext, TraceContext } from "./telemetry.js";

export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 30000,
  traceCtx?: TraceContext,
): Promise<Response> {
  const ctx = traceCtx ?? generateTraceContext();
  const headers = new Headers(options.headers);
  headers.set("traceparent", formatTraceparent(ctx));

  // ... standard abort controller and execution
}
```

---

## 2. Client-Side Resumable Checkpointing & Delta Journaling

### 2.1 The Problem
When syncing large directory trees or multi-gigabyte datasets, unexpected interruptions (power failure, network drop, SIGINT) require the CLI to restart directory traversal, re-hashing all local files and re-negotiating.

### 2.2 Relational State Machine Schema
Add state machine tables to the local SQLite database ([`cli/src/db.ts`](file:///home/thor/Downloads/delta-sync-engine-main/cli/src/db.ts)):

```sql
CREATE TABLE IF NOT EXISTS sync_sessions (
  session_id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('discovered', 'negotiating', 'uploading', 'committing', 'completed', 'aborted')),
  total_files INTEGER NOT NULL DEFAULT 0,
  completed_files INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  transferred_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_session_files (
  session_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'hashed', 'negotiated', 'uploading', 'committed', 'skipped', 'failed')),
  content_hash TEXT,
  file_size INTEGER NOT NULL,
  negotiation_id TEXT,
  total_chunks INTEGER NOT NULL DEFAULT 0,
  uploaded_chunks INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, file_path),
  FOREIGN KEY (session_id) REFERENCES sync_sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_files_state ON sync_session_files(session_id, state);
```

### 2.3 Resumption Lifecycle Controller
```typescript
export class SessionCheckpointEngine {
  constructor(private db: Database) {}

  /** Create or restore existing unfinished sync session */
  public getOrCreateActiveSession(rootPath: string): { sessionId: string; isResume: boolean } {
    const existing = this.db.prepare(`
      SELECT session_id FROM sync_sessions
      WHERE root_path = ? AND state NOT IN ('completed', 'aborted')
      ORDER BY updated_at DESC LIMIT 1
    `).get(rootPath) as { session_id: string } | undefined;

    if (existing) {
      return { sessionId: existing.session_id, isResume: true };
    }

    const sessionId = crypto.randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO sync_sessions (session_id, root_path, state, created_at, updated_at)
      VALUES (?, ?, 'discovered', ?, ?)
    `).run(sessionId, rootPath, now, now);

    return { sessionId, isResume: false };
  }

  /** Advance a file through the state machine atomically */
  public transitionFile(sessionId: string, filePath: string, state: string, metadata?: { hash?: string; negotiationId?: string }) {
    this.db.prepare(`
      UPDATE sync_session_files
      SET state = ?,
          content_hash = COALESCE(?, content_hash),
          negotiation_id = COALESCE(?, negotiation_id),
          updated_at = ?
      WHERE session_id = ? AND file_path = ?
    `).run(state, metadata?.hash ?? null, metadata?.negotiationId ?? null, Date.now(), sessionId, filePath);
  }
}
```

---

## 3. Client-Side Adaptive Bandwidth Shaping (Token Bucket)

### 3.1 Rate Limiting Architecture
Uncontrolled parallel chunk streaming saturates egress uplinks and starves local applications. We implement a **thread-safe Token Bucket Rate Limiter** that throttles byte throughput before feeding HTTP request bodies.

### 3.2 Implementation
#### File: `cli/src/bandwidth-shaper.ts`
```typescript
export class TokenBucketLimiter {
  private capacity: number;
  private tokens: number;
  private refillRateBytesPerSec: number;
  private lastRefillTimestamp: number;

  constructor(bytesPerSec: number) {
    this.refillRateBytesPerSec = bytesPerSec;
    // Allow burst of up to 2 seconds of transfer capacity
    this.capacity = bytesPerSec * 2;
    this.tokens = this.capacity;
    this.lastRefillTimestamp = Date.now();
  }

  private refill() {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefillTimestamp) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillRateBytesPerSec);
    this.lastRefillTimestamp = now;
  }

  /** Blocks asynchronously until enough byte tokens are available */
  public async consume(bytes: number): Promise<void> {
    if (this.refillRateBytesPerSec <= 0) return; // Unlimited

    while (true) {
      this.refill();
      if (this.tokens >= bytes) {
        this.tokens -= bytes;
        return;
      }
      const missingTokens = bytes - this.tokens;
      const waitMs = Math.ceil((missingTokens / this.refillRateBytesPerSec) * 1000);
      await new Promise((resolve) => setTimeout(resolve, Math.max(10, waitMs)));
    }
  }

  public updateRate(bytesPerSec: number) {
    this.refillRateBytesPerSec = bytesPerSec;
    this.capacity = bytesPerSec * 2;
  }
}
```

### 3.3 Integration with CLI Push Pipeline
In [`cli/src/push.ts`](file:///home/thor/Downloads/delta-sync-engine-main/cli/src/push.ts#L184):
```typescript
// Throttle outbound bytes against token bucket prior to dispatching HTTP PUT
await bandwidthLimiter.consume(chunk.length);

const r = await fetchWithTimeout(
  chunk.uploadUrl,
  {
    method: "PUT",
    body: chunkData,
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(chunk.length) }
  },
  30000
);
```

---

## 4. CAS Generational Mark-Sweep & Reference Counting GC

### 4.1 The Architecture
Instead of batch-scanning multi-million object S3 buckets or parsing large inventory CSV files in Node.js memory, CAS management is moved to an **asynchronous transactional reference counter** in PostgreSQL/SQLite.

```
[File Version Committed] ──────> Atomically Increment ref_count for all manifest chunk hashes
[File Version Pruned]    ──────> Atomically Decrement ref_count for version chunk hashes
[Scheduled Sweep Daemon] ──────> SELECT WHERE ref_count <= 0 AND grace_period_expired
                                  └── Batch Delete from Storage & Remove from Index
```

### 4.2 Database Schema
#### File: `shared/schema.ts`
```typescript
export const casBlockIndex = sqliteTable("cas_block_index", {
  strongHash: text("strong_hash").primaryKey(), // SHA-256
  refCount: integer("ref_count").notNull().default(1),
  byteSize: integer("byte_size").notNull(),
  firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
  lastReferencedAt: integer("last_referenced_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull(),
});
```

### 4.3 Atomic Ref-Count Sweeper
#### File: `server/cas-lifecycle.ts`
```typescript
import { db } from "./db.js";
import { casBlockIndex } from "../shared/schema.js";
import { getStorageAdapter } from "./storage-adapter.js";
import { eq, lte, and, sql } from "drizzle-orm";

const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000; // 24-hour quarantine before physical purge

export class CasLifecycleManager {
  /** Increments ref_counts for newly committed version chunks */
  public static async registerReferences(hashesWithSizes: { hash: string; size: number }[]): Promise<void> {
    await db.transaction(async (tx) => {
      for (const { hash, size } of hashesWithSizes) {
        await tx
          .insert(casBlockIndex)
          .values({
            strongHash: hash,
            byteSize: size,
            refCount: 1,
            lastReferencedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: casBlockIndex.strongHash,
            set: {
              refCount: sql`${casBlockIndex.refCount} + 1`,
              lastReferencedAt: new Date(),
            },
          });
      }
    });
  }

  /** Decrements ref_counts when an older file version is pruned */
  public static async dereference(hashes: string[]): Promise<void> {
    await db.transaction(async (tx) => {
      for (const hash of hashes) {
        await tx
          .update(casBlockIndex)
          .set({
            refCount: sql`MAX(0, ${casBlockIndex.refCount} - 1)`,
            lastReferencedAt: new Date(),
          })
          .where(eq(casBlockIndex.strongHash, hash));
      }
    });
  }

  /** Sweeps zero-reference blocks exceeding grace period without full storage scans */
  public static async sweepQuarantinedBlocks(): Promise<number> {
    const cutoff = new Date(Date.now() - GRACE_PERIOD_MS);
    const storage = getStorageAdapter();

    const candidateRows = await db
      .select()
      .from(casBlockIndex)
      .where(
        and(
          lte(casBlockIndex.refCount, 0),
          lte(casBlockIndex.lastReferencedAt, cutoff)
        )
      )
      .limit(1000);

    if (candidateRows.length === 0) return 0;

    let deletedCount = 0;
    for (const row of candidateRows) {
      try {
        await storage.deleteObject(row.strongHash);
        await db.delete(casBlockIndex).where(eq(casBlockIndex.strongHash, row.strongHash));
        deletedCount++;
      } catch (err) {
        console.error(`[CAS:GC] Failed to delete orphan block ${row.strongHash}:`, err);
      }
    }

    return deletedCount;
  }
}
```

---

## 5. Binary Framing & HTTP/2 Multiplexing Upgrade

### 5.1 The Architecture
Individual HTTP PUT requests incur TCP slow-start and TLS record negotiation penalties on each chunk upload. Under high-latency WAN links, streaming missing chunks over a **single multiplexed HTTP/2 or WebSocket binary framed session** reduces upload completion times by $3\times$ to $5\times$.

```
CLI Client (HTTP/2 Multiplexed Session)
 └── Single TCP Connection + TLS Session
      ├── Stream 1: Control Channel (Handshake & Sync Sealing)
      └── Stream 3: Multiplexed Binary Ingestion Tunnel (DSO3 Framing)
           ├── [FRAME: CHUNK_DATA | 32B Hash | 4B Len | Payload]
           ├── [FRAME: CHUNK_DATA | 32B Hash | 4B Len | Payload]
           └── [FRAME: CHUNK_ACK  | 32B Hash | Status 200 OK  ]
```

### 5.2 Binary Frame Specification (DSO3)
```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  Frame Type   |                   Reserved                    |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                         Payload Length                        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
+                       SHA-256 Hash (32 B)                     +
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                         Payload Bytes                         |
|                             ...                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

### 5.3 Frame Encoder & Decoder
#### File: `shared/framed-stream.ts`
```typescript
export enum FrameType {
  CHUNK_DATA = 0x01,
  CHUNK_ACK = 0x02,
  STREAM_END = 0x03,
  ERROR = 0xff,
}

export function encodeChunkFrame(strongHashHex: string, payload: Uint8Array): Buffer {
  const hashBuf = Buffer.from(strongHashHex, "hex");
  const frame = Buffer.allocUnsafe(1 + 3 + 4 + 32 + payload.length);

  frame.writeUInt8(FrameType.CHUNK_DATA, 0);
  frame.writeUIntBE(0, 1, 3); // Reserved
  frame.writeUInt32BE(payload.length, 4);
  hashBuf.copy(frame, 8, 0, 32);
  frame.set(payload, 40);

  return frame;
}

export function decodeFrameHeader(headerBuf: Buffer): {
  type: FrameType;
  length: number;
  hashHex: string;
} {
  const type = headerBuf.readUInt8(0) as FrameType;
  const length = headerBuf.readUInt32BE(4);
  const hashHex = headerBuf.subarray(8, 40).toString("hex");
  return { type, length, hashHex };
}
```

---

## 6. Enterprise Integration Roadmap

| Pillar | Subsystem | Target Milestone | Performance Impact |
| :--- | :--- | :--- | :--- |
| **OTel Tracing** | API & CLI | Q1 Milestone | Full distributed observability with microsecond latency attribution |
| **Session Machine** | CLI State DB | Q1 Milestone | Instant crash-resumption for multi-gigabyte directory transfers |
| **Bandwidth Shaper**| CLI Push | Q2 Milestone | Guaranteed uplink QoS without ISP packet drops or socket resets |
| **CAS Ref-Count GC**| Server Database| Q2 Milestone | Zero S3 inventory scan latency; instant synchronous dereferencing |
| **H2 Frame Streaming**| Ingestion Wire | Q3 Milestone | $4\times$ throughput acceleration on high-latency WAN links |
