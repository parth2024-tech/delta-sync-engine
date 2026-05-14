import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

mkdirSync(".deltasync", { recursive: true });

const CACHE_PATH = ".deltasync/cache.json";

interface FileRow {
  path: string;
  last_mtime: number;
  last_size: number;
  last_hash: string;
  server_version: number;
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
  return load().files[path];
}

export function upsertFile(path: string, mtime: number, size: number, hash: string, version: number) {
  const data = load();
  data.files[path] = {
    path,
    last_mtime: mtime,
    last_size: size,
    last_hash: hash,
    server_version: version,
  };
  save(data);
}

/** Reserved for future local signature caching (previously SQLite). */
export function getSigCache(_hash: string) {
  return [] as { block_index: number; weak_hash: number; strong_hash: string; offset_val: number; length_val: number }[];
}

export function saveSigCache(_hash: string, _sigs: { block_index: number; weak_hash: number; strong_hash: string; offset_val: number; length_val: number }[]) {
  /* no-op */
}
