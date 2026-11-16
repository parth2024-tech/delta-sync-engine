import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import {
  setNegotiation,
  getNegotiation,
  clearNegotiation,
  cleanupExpiredNegotiations,
  NegotiationPayload,
} from "../server/negotiation-store-db";
import { db } from "../server/db";
import { negotiations, users } from "../shared/schema";
import { eq } from "drizzle-orm";

describe("Distributed Database Negotiation Store", () => {
  const testUserId = "usr_test_owner_uuid";
  const testId = "test-neg-uuid-12345678";
  const dummyPayload: NegotiationPayload = {
    userId: testUserId,
    path: "documents/presentation.pdf",
    chunking: "cdc",
    blockSize: 16384,
    newSize: 100000,
    contentSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    chunks: [
      { strongHash: "hash1", length: 40000, weakHash: 111 },
      { strongHash: "hash2", length: 60000, weakHash: 222 },
    ],
    missingChunkHashes: ["hash2"], // hash1 is already in CAS!
    snapshotCurrentVersionId: "ver_snapshot_01",
  };

  beforeAll(async () => {
    // Seed test user to satisfy foreign key constraint
    await db
      .insert(users)
      .values({
        id: testUserId,
        email: "test-owner@deltasync.local",
        passwordHash: "hash_secret",
      })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, testUserId));
  });

  beforeEach(async () => {
    await clearNegotiation(testId);
  });

  afterEach(async () => {
    await clearNegotiation(testId);
  });

  it("persists negotiation session into the database and retrieves it accurately", async () => {
    await setNegotiation(testId, dummyPayload);

    // Verify row directly in DB
    const row = await db.select().from(negotiations).where(eq(negotiations.id, testId));
    expect(row).toHaveLength(1);
    expect(row[0]!.userId).toBe(testUserId);
    expect(row[0]!.path).toBe("documents/presentation.pdf");

    // Retrieve via store API
    const retrieved = await getNegotiation(testId);
    expect(retrieved).toBeDefined();
    expect(retrieved?.userId).toBe(dummyPayload.userId);
    expect(retrieved?.path).toBe(dummyPayload.path);
    expect(retrieved?.newSize).toBe(dummyPayload.newSize);
    expect(retrieved?.chunks).toHaveLength(2);
    expect(retrieved?.missingChunkHashes).toEqual(["hash2"]);
    expect(retrieved?.snapshotCurrentVersionId).toBe("ver_snapshot_01");
  });

  it("updates existing negotiation on conflict (idempotent re-negotiation)", async () => {
    await setNegotiation(testId, dummyPayload);

    const updatedPayload: NegotiationPayload = {
      ...dummyPayload,
      newSize: 150000,
      missingChunkHashes: ["hash1", "hash2"],
    };

    await setNegotiation(testId, updatedPayload);

    const retrieved = await getNegotiation(testId);
    expect(retrieved?.newSize).toBe(150000);
    expect(retrieved?.missingChunkHashes).toEqual(["hash1", "hash2"]);
  });

  it("clears negotiation session explicitly after commit", async () => {
    await setNegotiation(testId, dummyPayload);
    expect(await getNegotiation(testId)).not.toBeNull();

    await clearNegotiation(testId);
    expect(await getNegotiation(testId)).toBeNull();
  });
});
