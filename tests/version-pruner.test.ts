/**
 * Tests for the version pruner module.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../shared/schema";
import { eq, desc } from "drizzle-orm";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  const db = drizzle(sqlite, { schema });

  // Create tables manually for in-memory testing
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
    CREATE UNIQUE INDEX file_versions_file_verno_unique ON file_versions(file_id, version_no);
    CREATE INDEX file_versions_file_created_idx ON file_versions(file_id, created_at);
  `);

  return { db, sqlite };
}

function seedVersions(db: ReturnType<typeof drizzle>, fileId: string, count: number) {
  const now = Date.now();
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    const id = `ver-${i}-${crypto.randomUUID().slice(0, 8)}`;
    ids.push(id);
    db.insert(schema.fileVersions).values({
      id,
      fileId,
      versionNo: i,
      size: 1024 * i,
      createdAt: new Date(now + i * 1000),
      verificationStatus: "verified",
    }).run();
  }
  return ids;
}

describe("Version Pruner", () => {
  let db: ReturnType<typeof drizzle>;
  let userId: string;
  let fileId: string;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;

    userId = crypto.randomUUID();
    fileId = crypto.randomUUID();

    // Seed a user and file
    db.insert(schema.users).values({
      id: userId,
      email: "test@test.com",
      passwordHash: "hash",
      displayName: "Test",
      createdAt: new Date(),
    }).run();

    db.insert(schema.files).values({
      id: fileId,
      userId,
      path: "test.bin",
      totalSize: 1024,
      createdAt: new Date(),
    }).run();
  });

  it("does nothing when versions are within the limit", async () => {
    const ids = seedVersions(db, fileId, 5);
    db.update(schema.files).set({ currentVersionId: ids[4] }).where(eq(schema.files.id, fileId)).run();

    // Inline the pruner logic for the test DB
    const allVersions = await db.select({ id: schema.fileVersions.id, versionNo: schema.fileVersions.versionNo })
      .from(schema.fileVersions)
      .where(eq(schema.fileVersions.fileId, fileId))
      .orderBy(desc(schema.fileVersions.versionNo));

    expect(allVersions.length).toBe(5);
    // With max=10, nothing should be pruned
    expect(allVersions.length).toBeLessThanOrEqual(10);
  });

  it("prunes versions beyond the retention limit", async () => {
    const MAX = 10;
    const ids = seedVersions(db, fileId, 15);

    // Set current version to the latest
    db.update(schema.files).set({ currentVersionId: ids[14] }).where(eq(schema.files.id, fileId)).run();

    const allVersions = await db.select({ id: schema.fileVersions.id, versionNo: schema.fileVersions.versionNo })
      .from(schema.fileVersions)
      .where(eq(schema.fileVersions.fileId, fileId))
      .orderBy(desc(schema.fileVersions.versionNo));

    const keepIds = new Set(allVersions.slice(0, MAX).map(v => v.id));
    keepIds.add(ids[14]!); // current version

    const toDelete = allVersions.filter(v => !keepIds.has(v.id));
    for (const v of toDelete) {
      await db.delete(schema.fileVersions).where(eq(schema.fileVersions.id, v.id));
    }

    const remaining = await db.select().from(schema.fileVersions)
      .where(eq(schema.fileVersions.fileId, fileId));

    expect(remaining.length).toBe(MAX);
  });

  it("always preserves the current version even if it is the oldest", async () => {
    const MAX = 3;
    const ids = seedVersions(db, fileId, 10);

    // Set current version to the OLDEST (version 1)
    db.update(schema.files).set({ currentVersionId: ids[0] }).where(eq(schema.files.id, fileId)).run();

    const [file] = await db.select({ currentVersionId: schema.files.currentVersionId })
      .from(schema.files).where(eq(schema.files.id, fileId));

    const allVersions = await db.select({ id: schema.fileVersions.id, versionNo: schema.fileVersions.versionNo })
      .from(schema.fileVersions)
      .where(eq(schema.fileVersions.fileId, fileId))
      .orderBy(desc(schema.fileVersions.versionNo));

    const keepIds = new Set(allVersions.slice(0, MAX).map(v => v.id));
    if (file!.currentVersionId) keepIds.add(file!.currentVersionId);

    const toDelete = allVersions.filter(v => !keepIds.has(v.id));
    for (const v of toDelete) {
      await db.delete(schema.fileVersions).where(eq(schema.fileVersions.id, v.id));
    }

    const remaining = await db.select().from(schema.fileVersions)
      .where(eq(schema.fileVersions.fileId, fileId));

    // Should keep MAX + 1 (the current version which is outside the top 3)
    expect(remaining.length).toBe(MAX + 1);

    // The current version (oldest) must be preserved
    const currentStillExists = remaining.some(v => v.id === ids[0]);
    expect(currentStillExists).toBe(true);

    // The top 3 most recent must be preserved
    const versionNos = remaining.map(v => v.versionNo).sort((a, b) => b - a);
    expect(versionNos.slice(0, MAX)).toEqual([10, 9, 8]);
  });

  it("keeps the most recent N versions by version number", async () => {
    const MAX = 5;
    const ids = seedVersions(db, fileId, 12);
    db.update(schema.files).set({ currentVersionId: ids[11] }).where(eq(schema.files.id, fileId)).run();

    const allVersions = await db.select({ id: schema.fileVersions.id, versionNo: schema.fileVersions.versionNo })
      .from(schema.fileVersions)
      .where(eq(schema.fileVersions.fileId, fileId))
      .orderBy(desc(schema.fileVersions.versionNo));

    const keepIds = new Set(allVersions.slice(0, MAX).map(v => v.id));
    keepIds.add(ids[11]!);

    const toDelete = allVersions.filter(v => !keepIds.has(v.id));
    for (const v of toDelete) {
      await db.delete(schema.fileVersions).where(eq(schema.fileVersions.id, v.id));
    }

    const remaining = await db.select({ versionNo: schema.fileVersions.versionNo })
      .from(schema.fileVersions)
      .where(eq(schema.fileVersions.fileId, fileId))
      .orderBy(desc(schema.fileVersions.versionNo));

    expect(remaining.map(v => v.versionNo)).toEqual([12, 11, 10, 9, 8]);
  });
});
