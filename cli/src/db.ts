import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import path from "path";

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

export function upsertFile(filePath: string, mtime: number, size: number, hash: string, version: number) {
  db.prepare(`
    INSERT INTO files (path, last_mtime, last_size, last_hash, server_version, last_accessed)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      last_mtime = excluded.last_mtime,
      last_size = excluded.last_size,
      last_hash = excluded.last_hash,
      server_version = excluded.server_version,
      last_accessed = excluded.last_accessed
  `).run(filePath, mtime, size, hash, version, Date.now());
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
  const remaining = db.prepare("SELECT path FROM files ORDER BY last_accessed ASC").all() as { path: string }[];
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
export function recordChunkStatus(negotiationId: string, strongHash: string, status: "pending" | "completed") {
  db.prepare(`
    INSERT INTO chunk_transfers (negotiation_id, strong_hash, status)
    VALUES (?, ?, ?)
    ON CONFLICT(negotiation_id, strong_hash) DO UPDATE SET status = excluded.status
  `).run(negotiationId, strongHash, status);
}

export function getCompletedChunks(negotiationId: string): Set<string> {
  const rows = db.prepare("SELECT strong_hash FROM chunk_transfers WHERE negotiation_id = ? AND status = 'completed'").all(negotiationId) as { strong_hash: string }[];
  return new Set(rows.map(r => r.strong_hash));
}

export function clearNegotiationChunks(negotiationId: string) {
  db.prepare("DELETE FROM chunk_transfers WHERE negotiation_id = ?").run(negotiationId);
}

// Negotiation Sessions API
export function getNegotiationSession(filePath: string): { negotiationId: string; contentSha256: string } | undefined {
  return db.prepare("SELECT negotiation_id as negotiationId, content_sha256 as contentSha256 FROM negotiation_sessions WHERE path = ?").get(filePath) as any;
}

export function saveNegotiationSession(filePath: string, negotiationId: string, contentSha256: string) {
  db.prepare(`
    INSERT INTO negotiation_sessions (path, negotiation_id, content_sha256)
    VALUES (?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      negotiation_id = excluded.negotiation_id,
      content_sha256 = excluded.content_sha256
  `).run(filePath, negotiationId, contentSha256);
}

export function deleteNegotiationSession(filePath: string) {
  db.prepare("DELETE FROM negotiation_sessions WHERE path = ?").run(filePath);
}

/** Reserved for future local signature caching. */
export function getSigCache(_hash: string) {
  return [] as { block_index: number; weak_hash: number; strong_hash: string; offset_val: number; length_val: number }[];
}

export function saveSigCache(_hash: string, _sigs: { block_index: number; weak_hash: number; strong_hash: string; offset_val: number; length_val: number }[]) {
  /* no-op */
}
