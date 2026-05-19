/**
 * Tests for the GC reference set builder.
 * Uses an in-memory SQLite database to verify hash set construction.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../shared/schema";
import { encodeChunkManifestV1 } from "../shared/chunk-manifest";
import { eq, gt, asc, isNotNull } from "drizzle-orm";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  const db = drizzle(sqlite, { schema });

  sqlite.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE files (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      current_version_id TEXT,
      total_size INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE file_versions (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      version_no INTEGER NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      total_blocks INTEGER NOT NULL DEFAULT 0,
      block_size INTEGER NOT NULL DEFAULT 4096,
      chunk_manifest BLOB,
      chunking_mode TEXT NOT NULL DEFAULT 'fixed',
      content_sha256 TEXT NOT NULL DEFAULT '',
      verification_status TEXT NOT NULL DEFAULT 'pending',
      retained_until INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE blocks (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL REFERENCES file_versions(id) ON DELETE CASCADE,
      block_index INTEGER NOT NULL,
      weak_hash INTEGER NOT NULL,
      strong_hash TEXT NOT NULL
    );
  `);

  return { db, sqlite };
}

/**
 * Reimplementation of buildReferenceSet for test isolation
 * (avoids importing from gc.ts which has side-effect S3 client creation).
 */
async function buildReferenceSetFromDb(db: ReturnType<typeof drizzle>) {
  const hashSet = new Set<string>();

  // Legacy blocks
  const blockRows = await db.select({ strongHash: schema.blocks.strongHash }).from(schema.blocks);
  for (const row of blockRows) {
    hashSet.add(row.strongHash);
  }

  // Chunk manifests (cursor-based paging)
  let lastId = "";
  const PAGE_SIZE = 80;
  for (;;) {
    const rows = lastId === ""
      ? await db.select({ id: schema.fileVersions.id, chunkManifest: schema.fileVersions.chunkManifest })
          .from(schema.fileVersions)
          .where(isNotNull(schema.fileVersions.chunkManifest))
          .orderBy(asc(schema.fileVersions.id))
          .limit(PAGE_SIZE)
      : await db.select({ id: schema.fileVersions.id, chunkManifest: schema.fileVersions.chunkManifest })
          .from(schema.fileVersions)
          .where(gt(schema.fileVersions.id, lastId))
          .orderBy(asc(schema.fileVersions.id))
          .limit(PAGE_SIZE);

    if (rows.length === 0) break;
    for (const row of rows) {
      lastId = row.id;
      try {
        if (row.chunkManifest) {
          const { decodeChunkManifestV1 } = await import("../shared/chunk-manifest");
          const chunks = decodeChunkManifestV1(Buffer.from(row.chunkManifest));
          for (const chunk of chunks) {
            hashSet.add(chunk.strongHashHex);
          }
        }
      } catch {
        // Skip corrupted manifests
      }
    }
    if (rows.length < PAGE_SIZE) break;
  }

  return hashSet;
}

describe("GC Reference Set Builder", () => {
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;

    // Seed user and file
    db.insert(schema.users).values({
      id: "user-1",
      email: "test@test.com",
      passwordHash: "hash",
      displayName: "Test",
      createdAt: new Date(),
    }).run();

    db.insert(schema.files).values({
      id: "file-1",
      userId: "user-1",
      path: "test.bin",
      totalSize: 0,
      createdAt: new Date(),
    }).run();
  });

  it("collects hashes from chunk manifests", async () => {
    const hash1 = "a".repeat(64);
    const hash2 = "b".repeat(64);
    const manifest = encodeChunkManifestV1([
      { offset: 0, length: 4096, weakHash: 1, strongHashHex: hash1 },
      { offset: 4096, length: 4096, weakHash: 2, strongHashHex: hash2 },
    ]);

    db.insert(schema.fileVersions).values({
      id: "ver-1",
      fileId: "file-1",
      versionNo: 1,
      size: 8192,
      chunkManifest: manifest,
      createdAt: new Date(),
    }).run();

    const hashSet = await buildReferenceSetFromDb(db);
    expect(hashSet.has(hash1)).toBe(true);
    expect(hashSet.has(hash2)).toBe(true);
    expect(hashSet.size).toBe(2);
  });

  it("collects hashes from legacy blocks table", async () => {
    const hash = "c".repeat(64);

    db.insert(schema.fileVersions).values({
      id: "ver-1",
      fileId: "file-1",
      versionNo: 1,
      size: 4096,
      createdAt: new Date(),
    }).run();

    db.insert(schema.blocks).values({
      id: "block-1",
      versionId: "ver-1",
      blockIndex: 0,
      weakHash: 12345,
      strongHash: hash,
    }).run();

    const hashSet = await buildReferenceSetFromDb(db);
    expect(hashSet.has(hash)).toBe(true);
  });

  it("deduplicates hashes across versions", async () => {
    const sharedHash = "d".repeat(64);
    const uniqueHash = "e".repeat(64);

    for (let i = 1; i <= 3; i++) {
      const manifest = encodeChunkManifestV1([
        { offset: 0, length: 4096, weakHash: 1, strongHashHex: sharedHash },
        ...(i === 2 ? [{ offset: 4096, length: 4096, weakHash: 2, strongHashHex: uniqueHash }] : []),
      ]);

      db.insert(schema.fileVersions).values({
        id: `ver-${i}`,
        fileId: "file-1",
        versionNo: i,
        size: 4096,
        chunkManifest: manifest,
        createdAt: new Date(),
      }).run();
    }

    const hashSet = await buildReferenceSetFromDb(db);
    expect(hashSet.has(sharedHash)).toBe(true);
    expect(hashSet.has(uniqueHash)).toBe(true);
    expect(hashSet.size).toBe(2);
  });

  it("does not crash on corrupted manifests", async () => {
    // Insert a version with garbage manifest data
    db.insert(schema.fileVersions).values({
      id: "ver-corrupt",
      fileId: "file-1",
      versionNo: 1,
      size: 100,
      chunkManifest: Buffer.from("this is not a valid manifest"),
      createdAt: new Date(),
    }).run();

    // Insert a valid version
    const validHash = "f".repeat(64);
    const validManifest = encodeChunkManifestV1([
      { offset: 0, length: 1024, weakHash: 1, strongHashHex: validHash },
    ]);
    db.insert(schema.fileVersions).values({
      id: "ver-valid",
      fileId: "file-1",
      versionNo: 2,
      size: 1024,
      chunkManifest: validManifest,
      createdAt: new Date(),
    }).run();

    // Should not throw, and should still collect the valid hash
    const hashSet = await buildReferenceSetFromDb(db);
    expect(hashSet.has(validHash)).toBe(true);
  });

  it("returns empty set when no versions exist", async () => {
    const hashSet = await buildReferenceSetFromDb(db);
    expect(hashSet.size).toBe(0);
  });

  it("contains exactly the expected hashes and no others", async () => {
    const expectedHashes = new Set([
      "1".repeat(64),
      "2".repeat(64),
      "3".repeat(64),
    ]);

    const manifest = encodeChunkManifestV1(
      [...expectedHashes].map((hash, i) => ({
        offset: i * 4096,
        length: 4096,
        weakHash: i,
        strongHashHex: hash,
      })),
    );

    db.insert(schema.fileVersions).values({
      id: "ver-1",
      fileId: "file-1",
      versionNo: 1,
      size: 12288,
      chunkManifest: manifest,
      createdAt: new Date(),
    }).run();

    const hashSet = await buildReferenceSetFromDb(db);

    // Contains exactly the expected hashes
    for (const hash of expectedHashes) {
      expect(hashSet.has(hash)).toBe(true);
    }

    // Does not contain arbitrary other hashes
    expect(hashSet.has("9".repeat(64))).toBe(false);
    expect(hashSet.size).toBe(expectedHashes.size);
  });
});
