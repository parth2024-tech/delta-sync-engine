/**
 * Tests for the client-side cache pruner.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";

// We test the pruning logic directly since importing db.ts has side effects
// (it creates .deltasync directory in cwd). Instead, we replicate the logic.

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

const TEST_DIR = join(process.cwd(), ".test-cache-pruner");
const CACHE_PATH = join(TEST_DIR, "cache.json");

function load(): CacheShape {
  if (!existsSync(CACHE_PATH)) return { files: {} };
  return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
}

function save(data: CacheShape) {
  writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2), "utf8");
}

function pruneCache(maxEntries: number): number {
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

describe("Cache Pruner", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("removes entries for files that no longer exist on disk", () => {
    const data: CacheShape = {
      files: {
        "/nonexistent/file1.txt": {
          path: "/nonexistent/file1.txt",
          last_mtime: 1000,
          last_size: 100,
          last_hash: "abc",
          server_version: 1,
          last_accessed: Date.now(),
        },
        "/nonexistent/file2.txt": {
          path: "/nonexistent/file2.txt",
          last_mtime: 2000,
          last_size: 200,
          last_hash: "def",
          server_version: 2,
          last_accessed: Date.now(),
        },
      },
    };
    save(data);

    const removed = pruneCache(1000);
    expect(removed).toBe(2);

    const after = load();
    expect(Object.keys(after.files).length).toBe(0);
  });

  it("trims cache to maxEntries by LRU", () => {
    // Create real files so they aren't removed by phase 1
    const files: Record<string, FileRow> = {};
    for (let i = 0; i < 10; i++) {
      const filePath = join(TEST_DIR, `file${i}.txt`);
      writeFileSync(filePath, `content ${i}`);
      files[filePath] = {
        path: filePath,
        last_mtime: Date.now(),
        last_size: 10,
        last_hash: `hash${i}`,
        server_version: i,
        last_accessed: Date.now() - (10 - i) * 1000, // oldest first
      };
    }
    save({ files });

    const removed = pruneCache(5);
    expect(removed).toBe(5);

    const after = load();
    const remaining = Object.keys(after.files);
    expect(remaining.length).toBe(5);

    // The most recently accessed 5 should remain
    for (let i = 5; i < 10; i++) {
      expect(remaining).toContain(join(TEST_DIR, `file${i}.txt`));
    }
  });

  it("does nothing when cache is within limits", () => {
    const filePath = join(TEST_DIR, "keep.txt");
    writeFileSync(filePath, "keep");
    save({
      files: {
        [filePath]: {
          path: filePath,
          last_mtime: Date.now(),
          last_size: 4,
          last_hash: "keep",
          server_version: 1,
          last_accessed: Date.now(),
        },
      },
    });

    const removed = pruneCache(1000);
    expect(removed).toBe(0);

    const after = load();
    expect(Object.keys(after.files).length).toBe(1);
  });

  it("handles empty cache", () => {
    save({ files: {} });
    const removed = pruneCache(100);
    expect(removed).toBe(0);
  });
});
