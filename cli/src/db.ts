import Database from "better-sqlite3";
import { mkdirSync } from "fs";

mkdirSync(".deltasync", { recursive: true });

const db = new Database(".deltasync/cache.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    path             TEXT PRIMARY KEY,
    last_mtime       INTEGER NOT NULL DEFAULT 0,
    last_size        INTEGER NOT NULL DEFAULT 0,
    last_hash        TEXT    NOT NULL DEFAULT '',
    server_version   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sig_cache (
    content_hash  TEXT    NOT NULL,
    block_index   INTEGER NOT NULL,
    weak_hash     INTEGER NOT NULL,
    strong_hash   TEXT    NOT NULL,
    offset_val    INTEGER NOT NULL,
    length_val    INTEGER NOT NULL,
    PRIMARY KEY (content_hash, block_index)
  );
`);

export function getFile(path: string) {
  return db.prepare("SELECT * FROM files WHERE path = ?").get(path) as {
    path: string; last_mtime: number; last_size: number; last_hash: string; server_version: number;
  } | undefined;
}

export function upsertFile(path: string, mtime: number, size: number, hash: string, version: number) {
  db.prepare(`INSERT INTO files (path, last_mtime, last_size, last_hash, server_version)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET last_mtime=excluded.last_mtime,
      last_size=excluded.last_size, last_hash=excluded.last_hash,
      server_version=excluded.server_version`).run(path, mtime, size, hash, version);
}

export function getSigCache(hash: string) {
  return db.prepare("SELECT * FROM sig_cache WHERE content_hash = ? ORDER BY block_index")
    .all(hash) as { block_index: number; weak_hash: number; strong_hash: string; offset_val: number; length_val: number }[];
}

export function saveSigCache(hash: string, sigs: { block_index: number; weak_hash: number; strong_hash: string; offset_val: number; length_val: number }[]) {
  const ins = db.prepare(`INSERT OR REPLACE INTO sig_cache VALUES (?, ?, ?, ?, ?, ?)`);
  const tx  = db.transaction(() => { for (const s of sigs) ins.run(hash, s.block_index, s.weak_hash, s.strong_hash, s.offset_val, s.length_val); });
  tx();
}
