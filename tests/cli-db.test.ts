import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getFile,
  upsertFile,
  listFiles,
  pruneCache,
  recordChunkStatus,
  getCompletedChunks,
  clearNegotiationChunks,
  saveNegotiationSession,
  getNegotiationSession,
  deleteNegotiationSession,
} from "../cli/src/db";
import fs from "node:fs";
import path from "node:path";

describe("CLI Cache & Journal Database", () => {
  const testFile1 = "test-sample-file-1.dat";
  const testFile2 = "test-sample-file-2.dat";

  beforeEach(() => {
    // Write temporary dummy files so pruneCache doesn't delete them
    fs.writeFileSync(testFile1, "hello world");
    fs.writeFileSync(testFile2, "deltasync chunk data");
  });

  afterEach(() => {
    if (fs.existsSync(testFile1)) fs.unlinkSync(testFile1);
    if (fs.existsSync(testFile2)) fs.unlinkSync(testFile2);
  });

  describe("File Cache Operations", () => {
    it("should upsert and retrieve cached file metadata", () => {
      const now = Date.now();
      upsertFile(testFile1, now, 1024, "hash_123456", 1);

      const cached = getFile(testFile1);
      expect(cached).toBeDefined();
      expect(cached?.path).toBe(testFile1);
      expect(cached?.last_size).toBe(1024);
      expect(cached?.last_hash).toBe("hash_123456");
      expect(cached?.server_version).toBe(1);
    });

    it("should update file metadata on conflict", () => {
      upsertFile(testFile1, 1000, 500, "hash_v1", 1);
      upsertFile(testFile1, 2000, 800, "hash_v2", 2);

      const cached = getFile(testFile1);
      expect(cached?.server_version).toBe(2);
      expect(cached?.last_hash).toBe("hash_v2");
      expect(cached?.last_size).toBe(800);
    });

    it("should list cached files", () => {
      upsertFile(testFile1, 1000, 100, "h1", 1);
      upsertFile(testFile2, 1000, 200, "h2", 1);

      const list = listFiles();
      expect(list).toContain(testFile1);
      expect(list).toContain(testFile2);
    });

    it("should prune entries for non-existent files on disk", () => {
      const ghostFile = "ghost-file-does-not-exist.bin";
      upsertFile(ghostFile, 1000, 500, "ghost_hash", 1);

      expect(getFile(ghostFile)).toBeDefined();
      const removed = pruneCache(1000);
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(getFile(ghostFile)).toBeUndefined();
    });
  });

  describe("Stateful Journaling (Chunk Transfers)", () => {
    const negId = "neg_test_998877";

    it("should record completed chunk transfers and retrieve completed set", () => {
      recordChunkStatus(negId, "chunk_aaa", "pending");
      recordChunkStatus(negId, "chunk_bbb", "completed");
      recordChunkStatus(negId, "chunk_ccc", "completed");

      // Update pending to completed
      recordChunkStatus(negId, "chunk_aaa", "completed");

      const completed = getCompletedChunks(negId);
      expect(completed.has("chunk_aaa")).toBe(true);
      expect(completed.has("chunk_bbb")).toBe(true);
      expect(completed.has("chunk_ccc")).toBe(true);
      expect(completed.size).toBe(3);
    });

    it("should clear negotiation chunks atomically", () => {
      recordChunkStatus(negId, "chunk_xyz", "completed");
      expect(getCompletedChunks(negId).size).toBeGreaterThanOrEqual(1);

      clearNegotiationChunks(negId);
      expect(getCompletedChunks(negId).size).toBe(0);
    });
  });

  describe("Negotiation Session Reconciliation", () => {
    const sessionFile = "sample-session-file.bin";

    it("should save, retrieve, and delete negotiation sessions", () => {
      const negId = "neg_session_12345";
      const sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

      saveNegotiationSession(sessionFile, negId, sha256);

      const session = getNegotiationSession(sessionFile);
      expect(session).toBeDefined();
      expect(session?.negotiationId).toBe(negId);
      expect(session?.contentSha256).toBe(sha256);

      deleteNegotiationSession(sessionFile);
      expect(getNegotiationSession(sessionFile)).toBeUndefined();
    });
  });
});
