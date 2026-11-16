import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import crypto from "node:crypto";

mkdirSync(".deltasync", { recursive: true });

const dbPath = path.join(".deltasync", "cache.db");
const db = new Database(dbPath);

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    last_mtime REAL NOT NULL,
    last_size INTEGER NOT NULL,
    last_hash TEXT NOT NULL,
    server_version INTEGER NOT NULL,
    last_accessed INTEGER NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS chunk_transfers (
    negotiation_id TEXT,
    strong_hash TEXT,
    status TEXT NOT NULL,
    PRIMARY KEY (negotiation_id, strong_hash)
  );

  CREATE TABLE IF NOT EXISTS negotiation_sessions (
    path TEXT PRIMARY KEY,
    negotiation_id TEXT NOT NULL,
    content_sha256 TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_sessions (
    session_id TEXT PRIMARY KEY,
    root_path TEXT NOT NULL,
    state TEXT NOT NULL,
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
    state TEXT NOT NULL,
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
`);

export interface FileRow {
  path: string;
  last_mtime: number;
  last_size: number;
  last_hash: string;
  server_version: number;
  last_accessed?: number;
}

export function getFile(filePath: string): FileRow | undefined {
  const row = db.prepare("SELECT * FROM files WHERE path = ?").get(filePath) as FileRow | undefined;
  if (row) {
    db.prepare("UPDATE files SET last_accessed = ? WHERE path = ?").run(Date.now(), filePath);
  }
  return row;
}

export function upsertFile(
  filePath: string,
  mtime: number,
  size: number,
  hash: string,
  version: number,
) {
  db.prepare(
    `
    INSERT INTO files (path, last_mtime, last_size, last_hash, server_version, last_accessed)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      last_mtime = excluded.last_mtime,
      last_size = excluded.last_size,
      last_hash = excluded.last_hash,
      server_version = excluded.server_version,
      last_accessed = excluded.last_accessed
  `,
  ).run(filePath, mtime, size, hash, version, Date.now());
}

export function listFiles(): string[] {
  const rows = db.prepare("SELECT path FROM files").all() as { path: string }[];
  return rows.map((r) => r.path);
}

export function pruneCache(maxEntries = 1000): number {
  let removed = 0;
  // Phase 1: Remove entries for files that no longer exist on disk
  const paths = listFiles();
  for (const filePath of paths) {
    if (!existsSync(filePath)) {
      db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
      removed++;
    }
  }

  // Phase 2: Trim to maxEntries by LRU
  const remaining = db.prepare("SELECT path FROM files ORDER BY last_accessed ASC").all() as {
    path: string;
  }[];
  if (remaining.length > maxEntries) {
    const toRemove = remaining.length - maxEntries;
    for (let i = 0; i < toRemove; i++) {
      db.prepare("DELETE FROM files WHERE path = ?").run(remaining[i]!.path);
      removed++;
    }
  }
  return removed;
}

// Stateful Journaling API
export function recordChunkStatus(
  negotiationId: string,
  strongHash: string,
  status: "pending" | "completed",
) {
  db.prepare(
    `
    INSERT INTO chunk_transfers (negotiation_id, strong_hash, status)
    VALUES (?, ?, ?)
    ON CONFLICT(negotiation_id, strong_hash) DO UPDATE SET status = excluded.status
  `,
  ).run(negotiationId, strongHash, status);
}

export function getCompletedChunks(negotiationId: string): Set<string> {
  const rows = db
    .prepare(
      "SELECT strong_hash FROM chunk_transfers WHERE negotiation_id = ? AND status = 'completed'",
    )
    .all(negotiationId) as { strong_hash: string }[];
  return new Set(rows.map((r) => r.strong_hash));
}

export function clearNegotiationChunks(negotiationId: string) {
  db.prepare("DELETE FROM chunk_transfers WHERE negotiation_id = ?").run(negotiationId);
}

// Negotiation Sessions API
export function getNegotiationSession(
  filePath: string,
): { negotiationId: string; contentSha256: string } | undefined {
  return db
    .prepare(
      "SELECT negotiation_id as negotiationId, content_sha256 as contentSha256 FROM negotiation_sessions WHERE path = ?",
    )
    .get(filePath) as { negotiationId: string; contentSha256: string } | undefined;
}

export function saveNegotiationSession(
  filePath: string,
  negotiationId: string,
  contentSha256: string,
) {
  db.prepare(
    `
    INSERT INTO negotiation_sessions (path, negotiation_id, content_sha256)
    VALUES (?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      negotiation_id = excluded.negotiation_id,
      content_sha256 = excluded.content_sha256
  `,
  ).run(filePath, negotiationId, contentSha256);
}

export function deleteNegotiationSession(filePath: string) {
  db.prepare("DELETE FROM negotiation_sessions WHERE path = ?").run(filePath);
}

/** Reserved for future local signature caching. */
export function getSigCache(_hash: string) {
  return [] as {
    block_index: number;
    weak_hash: number;
    strong_hash: string;
    offset_val: number;
    length_val: number;
  }[];
}

export function saveSigCache(
  _hash: string,
  _sigs: {
    block_index: number;
    weak_hash: number;
    strong_hash: string;
    offset_val: number;
    length_val: number;
  }[],
) {
  /* no-op */
}

// ── Checkpointing State Machine API ──────────────────────────────────────────

export interface SyncSessionRow {
  session_id: string;
  root_path: string;
  state: string;
  total_files: number;
  completed_files: number;
  total_bytes: number;
  transferred_bytes: number;
  created_at: number;
  updated_at: number;
}

export interface SyncSessionFileRow {
  session_id: string;
  file_path: string;
  state:
    | "pending"
    | "hashed"
    | "negotiated"
    | "uploading"
    | "committing"
    | "committed"
    | "skipped"
    | "failed";
  content_hash: string | null;
  file_size: number;
  negotiation_id: string | null;
  total_chunks: number;
  uploaded_chunks: number;
  error: string | null;
  updated_at: number;
}

export function getOrCreateSyncSession(rootPath: string): { sessionId: string; isResume: boolean } {
  const existing = db
    .prepare(
      `SELECT session_id FROM sync_sessions
       WHERE root_path = ? AND state NOT IN ('completed', 'aborted')
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(rootPath) as { session_id: string } | undefined;

  if (existing) {
    return { sessionId: existing.session_id, isResume: true };
  }

  const sessionId = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO sync_sessions (session_id, root_path, state, created_at, updated_at)
     VALUES (?, ?, 'discovered', ?, ?)`,
  ).run(sessionId, rootPath, now, now);

  return { sessionId, isResume: false };
}

export function updateSyncSessionState(
  sessionId: string,
  state: string,
  stats?: {
    totalFiles?: number;
    completedFiles?: number;
    totalBytes?: number;
    transferredBytes?: number;
  },
) {
  db.prepare(
    `UPDATE sync_sessions
     SET state = ?,
         total_files = COALESCE(?, total_files),
         completed_files = COALESCE(?, completed_files),
         total_bytes = COALESCE(?, total_bytes),
         transferred_bytes = COALESCE(?, transferred_bytes),
         updated_at = ?
     WHERE session_id = ?`,
  ).run(
    state,
    stats?.totalFiles ?? null,
    stats?.completedFiles ?? null,
    stats?.totalBytes ?? null,
    stats?.transferredBytes ?? null,
    Date.now(),
    sessionId,
  );
}

export function setSessionFileState(
  sessionId: string,
  filePath: string,
  state: SyncSessionFileRow["state"],
  meta?: {
    hash?: string;
    fileSize?: number;
    negotiationId?: string;
    totalChunks?: number;
    uploadedChunks?: number;
    error?: string;
  },
) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sync_session_files (
       session_id, file_path, state, content_hash, file_size, negotiation_id,
       total_chunks, uploaded_chunks, error, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, file_path) DO UPDATE SET
       state = excluded.state,
       content_hash = COALESCE(excluded.content_hash, sync_session_files.content_hash),
       file_size = CASE WHEN excluded.file_size > 0 THEN excluded.file_size ELSE sync_session_files.file_size END,
       negotiation_id = COALESCE(excluded.negotiation_id, sync_session_files.negotiation_id),
       total_chunks = CASE WHEN excluded.total_chunks > 0 THEN excluded.total_chunks ELSE sync_session_files.total_chunks END,
       uploaded_chunks = CASE WHEN excluded.uploaded_chunks > 0 THEN excluded.uploaded_chunks ELSE sync_session_files.uploaded_chunks END,
       error = excluded.error,
       updated_at = excluded.updated_at`,
  ).run(
    sessionId,
    filePath,
    state,
    meta?.hash ?? null,
    meta?.fileSize ?? 0,
    meta?.negotiationId ?? null,
    meta?.totalChunks ?? 0,
    meta?.uploadedChunks ?? 0,
    meta?.error ?? null,
    now,
  );
}

export function getSessionFile(
  sessionId: string,
  filePath: string,
): SyncSessionFileRow | undefined {
  return db
    .prepare(`SELECT * FROM sync_session_files WHERE session_id = ? AND file_path = ?`)
    .get(sessionId, filePath) as SyncSessionFileRow | undefined;
}
