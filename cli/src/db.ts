import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

mkdirSync(".deltasync", { recursive: true });

const CACHE_PATH = ".deltasync/cache.json";

interface FileRow {
  path: string;
  last_mtime: number;
  last_size: number;
  last_hash: string;
  server_version: number;
  last_accessed?: number;
}

interface CacheShape {
  files: Record<string, FileRow>;
}

function load(): CacheShape {
  if (!existsSync(CACHE_PATH)) return { files: {} };
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as CacheShape;
  } catch {
    return { files: {} };
  }
}

function save(data: CacheShape) {
  writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2), "utf8");
}

export function getFile(path: string): FileRow | undefined {
  const data = load();
  const entry = data.files[path];
  if (entry) {
    // Touch last_accessed on read
    entry.last_accessed = Date.now();
    save(data);
  }
  return entry;
}

export function upsertFile(path: string, mtime: number, size: number, hash: string, version: number) {
  const data = load();
  data.files[path] = {
    path,
    last_mtime: mtime,
    last_size: size,
    last_hash: hash,
    server_version: version,
    last_accessed: Date.now(),
  };
  save(data);
}

/** List all tracked file paths in the cache. */
export function listFiles(): string[] {
  return Object.keys(load().files);
}

/**
 * Remove stale entries from the cache.
 * Evicts entries for files that no longer exist on disk,
 * then trims the cache to `maxEntries` by LRU (least recently accessed first).
 *
 * @returns Number of entries removed.
 */
export function pruneCache(maxEntries = 1000): number {
  const data = load();
  const entries = Object.entries(data.files);
  let removed = 0;

  // Phase 1: Remove entries for files that no longer exist on disk
  for (const [path] of entries) {
    if (!existsSync(path)) {
      delete data.files[path];
      removed++;
    }
  }

  // Phase 2: Trim to maxEntries by LRU
  const remaining = Object.entries(data.files);
  if (remaining.length > maxEntries) {
    remaining.sort((a, b) => (a[1].last_accessed ?? 0) - (b[1].last_accessed ?? 0));
    const toRemove = remaining.length - maxEntries;
    for (let i = 0; i < toRemove; i++) {
      delete data.files[remaining[i]![0]];
      removed++;
    }
  }

  if (removed > 0) save(data);
  return removed;
}

/** Reserved for future local signature caching (previously SQLite). */
export function getSigCache(_hash: string) {
  return [] as { block_index: number; weak_hash: number; strong_hash: string; offset_val: number; length_val: number }[];
}

export function saveSigCache(_hash: string, _sigs: { block_index: number; weak_hash: number; strong_hash: string; offset_val: number; length_val: number }[]) {
  /* no-op */
}
