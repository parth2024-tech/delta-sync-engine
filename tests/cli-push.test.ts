import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { performPush } from "../cli/src/push.js";
import * as api from "../cli/src/api.js";
import {
  upsertFile,
  getFile,
  saveNegotiationSession,
  getNegotiationSession,
  getCompletedChunks,
  clearNegotiationChunks,
  deleteNegotiationSession,
} from "../cli/src/db.js";
import type { Config } from "../cli/src/config.js";

const dummyCfg: Config = {
  serverUrl: "http://localhost:3000",
  token: "test-auth-token",
};

describe("CLI Push Engine (performPush)", () => {
  const testDir = path.join(process.cwd(), ".deltasync-test-push");
  const testFile = path.join(testDir, "sample-sync-file.txt");

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (fs.existsSync(testFile)) {
      deleteNegotiationSession(testFile);
      fs.unlinkSync(testFile);
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("throws an error when target file does not exist", async () => {
    await expect(performPush(path.join(testDir, "non-existent.txt"), dummyCfg)).rejects.toThrow(
      "File not found",
    );
  });

  it("skips negotiation and upload if local file content hash matches DB cache", async () => {
    const data = Buffer.from("unchanged deterministic content");
    fs.writeFileSync(testFile, data);
    const stat = fs.statSync(testFile);
    const { contentHash } = await import("../cli/src/rsync.js");
    const hash = await contentHash(data);

    // Seed file in DB cache
    upsertFile(testFile, stat.mtimeMs, stat.size, hash, 42);

    const negotiateSpy = vi.spyOn(api, "negotiate");

    const result = await performPush(testFile, dummyCfg);

    expect(negotiateSpy).not.toHaveBeenCalled();
    expect(result.versionNo).toBe(42);
    expect(result.bytesSaved).toBe(0);
  });

  it("performs full handshake, chunk upload, journaling, and commit for a new file", async () => {
    const fileContent = "A".repeat(50000); // 50KB to trigger chunking
    fs.writeFileSync(testFile, fileContent);

    // Mock negotiate response
    const mockMissingChunks = [
      {
        strongHash: "mock-strong-hash-1",
        uploadUrl: "http://localhost:3000/api/public/storage/upload?key=chunk1",
      },
    ];

    vi.spyOn(api, "negotiate").mockImplementation(async (_cfg, req) => {
      // Return the actual first chunk hash so push finds its signature
      return {
        negotiationId: "neg-test-uuid-1",
        missingChunks: [
          {
            strongHash: req.chunks[0]!.strongHash,
            uploadUrl: "http://localhost:3000/api/public/storage/upload?key=chunk0",
          },
        ],
      };
    });

    vi.spyOn(api, "commitSync").mockResolvedValue({
      versionNo: 2,
      bytesSaved: 1024,
    });

    // Mock fetch for PUT chunk upload
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200, statusText: "OK" }));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await performPush(testFile, dummyCfg);

    expect(result.versionNo).toBe(2);
    expect(result.bytesSaved).toBe(1024);

    // Verify S3 upload PUT call was made
    expect(fetchSpy).toHaveBeenCalled();
    const putCall = fetchSpy.mock.calls.find((c: [string, RequestInit]) => c[1]?.method === "PUT");
    expect(putCall).toBeDefined();

    // Verify cache updated in DB
    const cached = getFile(testFile);
    expect(cached).toBeDefined();
    expect(cached?.server_version).toBe(2);

    // Verify negotiation session was cleared
    expect(getNegotiationSession(testFile)).toBeUndefined();
  });

  it("resumes an interrupted negotiation session and skips already uploaded chunks", async () => {
    const fileContent = "B".repeat(60000);
    fs.writeFileSync(testFile, fileContent);

    let calculatedHash = "";
    vi.spyOn(api, "negotiate").mockImplementation(async (_cfg, req) => {
      calculatedHash = req.contentSha256;
      return {
        negotiationId: "neg-interrupted-01",
        missingChunks: req.chunks.map((c, i) => ({
          strongHash: c.strongHash,
          uploadUrl: `http://localhost:3000/api/public/storage/upload?key=chunk${i}`,
        })),
      };
    });

    // First do a negotiation to capture hash and chunk signatures
    const stat = fs.statSync(testFile);
    const data = fs.readFileSync(testFile);

    // Save existing session simulating crash
    const fakeNegId = "neg-interrupted-01";

    const resumeSpy = vi.spyOn(api, "resumeNegotiation").mockImplementation(async () => {
      return {
        negotiationId: fakeNegId,
        alreadyUploaded: 1,
        totalChunks: 2,
        missingChunks: [], // All chunks already on server
      };
    });

    const commitSpy = vi.spyOn(api, "commitSync").mockResolvedValue({
      versionNo: 5,
      bytesSaved: 30000,
    });

    // We manually simulate a session in DB with the exact sha256
    const { contentHash } = await import("../cli/src/rsync.js");
    const hash = await contentHash(data);
    saveNegotiationSession(testFile, fakeNegId, hash);

    const result = await performPush(testFile, dummyCfg);

    expect(resumeSpy).toHaveBeenCalledWith(dummyCfg, fakeNegId);
    expect(commitSpy).toHaveBeenCalledWith(dummyCfg, fakeNegId);
    expect(result.versionNo).toBe(5);
  });

  it("handles HTTP 503 Slow Down rate limit backoff and retries successfully", async () => {
    const fileContent = "C".repeat(40000);
    fs.writeFileSync(testFile, fileContent);

    vi.spyOn(api, "negotiate").mockImplementation(async (_cfg, req) => {
      return {
        negotiationId: "neg-backoff-test",
        missingChunks: [
          {
            strongHash: req.chunks[0]!.strongHash,
            uploadUrl: "http://localhost:3000/api/public/storage/upload?key=backoff_chunk",
          },
        ],
      };
    });

    vi.spyOn(api, "commitSync").mockResolvedValue({
      versionNo: 3,
      bytesSaved: 0,
    });

    // Mock fetch: first call returns 503 Slow Down, second call succeeds with 200
    let callCount = 0;
    const fetchSpy = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(null, { status: 503, statusText: "Slow Down" });
      }
      return new Response(null, { status: 200, statusText: "OK" });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await performPush(testFile, dummyCfg);

    expect(result.versionNo).toBe(3);
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});
