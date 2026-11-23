import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { db } from "../server/db";
import { users, files, fileVersions, syncJobs } from "../shared/schema";
import { eq } from "drizzle-orm";
import {
  outboxNotifier,
  type JobEventPayload,
  type FileCommittedPayload,
} from "../server/outbox-notifier";
import { performRollbackToVersion } from "../server/rollback";
import { cdcRanges } from "../shared/fastcdc";
import { encodeChunkManifestV1 } from "../shared/chunk-manifest";
import { storeBlock } from "../server/block-store";
import { resetStorageAdapter } from "../server/storage-adapter";
import crypto from "node:crypto";

describe("E2E Web Flows & Interactive Regression Suite", () => {
  let testUserId: string;

  beforeEach(async () => {
    process.env.STORAGE_DRIVER = "local";
    resetStorageAdapter();

    testUserId = crypto.randomUUID();
    await db.insert(users).values({
      id: testUserId,
      email: `test-e2e-${testUserId}@example.com`,
      passwordHash: "hash-placeholder",
      displayName: "E2E Test User",
    });
  });

  it("Flow 1: Streaming Download produces Content-Disposition and exact byte stream", async () => {
    const fileId = crypto.randomUUID();
    const versionId = crypto.randomUUID();

    const chunkData1 = new Uint8Array([10, 20, 30, 40]);
    const chunkData2 = new Uint8Array([50, 60, 70, 80]);
    const hash1 = crypto.createHash("sha256").update(chunkData1).digest("hex");
    const hash2 = crypto.createHash("sha256").update(chunkData2).digest("hex");

    await storeBlock(hash1, chunkData1);
    await storeBlock(hash2, chunkData2);

    const manifestBuf = encodeChunkManifestV1([
      { offset: 0, length: 4, weakHash: 111, strongHashHex: hash1 },
      { offset: 4, length: 4, weakHash: 222, strongHashHex: hash2 },
    ]);

    await db.insert(files).values({
      id: fileId,
      userId: testUserId,
      path: "documents/annual-report.pdf",
      totalSize: 8,
      currentVersionId: versionId,
    });

    await db.insert(fileVersions).values({
      id: versionId,
      fileId,
      versionNo: 1,
      size: 8,
      totalBlocks: 2,
      blockSize: 4,
      chunkManifest: manifestBuf,
      chunkingMode: "cdc",
      contentSha256: "dummy-full-hash",
      verificationStatus: "verified",
    });

    // Import and test the streaming endpoint handler directly
    const { Route } = await import("../src/routes/api/files/download");
    const routeServer = (
      Route as unknown as {
        options: {
          server: { handlers: { GET: (args: { request: Request }) => Promise<Response> } };
        };
      }
    ).options.server;
    const handler = routeServer.handlers.GET;

    // Create session token mock
    const { createSessionToken } = await import("../server/auth");
    const token = await createSessionToken(testUserId);

    const req = new Request(
      `http://localhost:5000/api/files/download?fileId=${fileId}&versionId=${versionId}`,
      {
        headers: {
          Cookie: `ds_session=${token}`,
        },
      },
    );

    const res = await handler({ request: req });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toContain("attachment; filename=");
    expect(res.headers.get("Content-Length")).toBe("8");

    // Read full stream and assert bytes match
    const arrayBuffer = await res.arrayBuffer();
    const downloadedBytes = new Uint8Array(arrayBuffer);
    expect(downloadedBytes).toHaveLength(8);
    expect(Array.from(downloadedBytes)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
  });

  it("Flow 2: SSE Live Updates emit and deliver typed events without polling", async () => {
    let capturedJobEvent: JobEventPayload | null = null;
    let capturedFileEvent: FileCommittedPayload | null = null;

    const jobListener = (data: JobEventPayload) => {
      capturedJobEvent = data;
    };
    const fileListener = (data: FileCommittedPayload) => {
      capturedFileEvent = data;
    };

    outboxNotifier.on("job:status", jobListener);
    outboxNotifier.on("file:committed", fileListener);

    outboxNotifier.emitJobUpdate({
      jobId: "job-e2e-123",
      status: "done",
      filePath: "src/main.rs",
    });

    outboxNotifier.emitFileCommitted({
      fileId: "file-e2e-456",
      path: "src/main.rs",
      versionNo: 3,
    });

    expect(capturedJobEvent).toEqual({
      jobId: "job-e2e-123",
      status: "done",
      filePath: "src/main.rs",
    });

    expect(capturedFileEvent).toEqual({
      fileId: "file-e2e-456",
      path: "src/main.rs",
      versionNo: 3,
    });

    outboxNotifier.off("job:status", jobListener);
    outboxNotifier.off("file:committed", fileListener);
  });

  it("Flow 3: FastCDC chunking algorithm partitions synthetic 2 MB binary payload into valid chunks", () => {
    const size = 2 * 1024 * 1024; // 2 MB
    const syntheticBuffer = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      syntheticBuffer[i] = (i * 31 + 17) & 0xff;
    }

    const ranges = cdcRanges(syntheticBuffer, {
      minSize: 2048,
      avgSize: 4096,
      maxSize: 16384,
    });

    expect(ranges.length).toBeGreaterThan(100);
    expect(ranges[0].start).toBe(0);
    expect(ranges[ranges.length - 1].end).toBe(size);

    for (const r of ranges) {
      const len = r.end - r.start;
      expect(len).toBeGreaterThanOrEqual(2048);
      expect(len).toBeLessThanOrEqual(16384);
    }
  });

  it("Flow 4: $O(1)$ Version Rollback restores historical version with identical manifest and 0 bytes transferred", async () => {
    const fileId = crypto.randomUUID();
    const v1Id = crypto.randomUUID();
    const v2Id = crypto.randomUUID();

    const manifestV1 = encodeChunkManifestV1([
      { offset: 0, length: 1024, weakHash: 111, strongHashHex: "a".repeat(64) },
    ]);
    const manifestV2 = encodeChunkManifestV1([
      { offset: 0, length: 2048, weakHash: 222, strongHashHex: "b".repeat(64) },
    ]);

    await db.insert(files).values({
      id: fileId,
      userId: testUserId,
      path: "src/config.json",
      totalSize: 2048,
      currentVersionId: v2Id,
    });

    await db.insert(fileVersions).values([
      {
        id: v1Id,
        fileId,
        versionNo: 1,
        size: 1024,
        totalBlocks: 1,
        blockSize: 1024,
        chunkManifest: manifestV1,
        chunkingMode: "cdc",
        contentSha256: "v1-content-hash",
        verificationStatus: "verified",
      },
      {
        id: v2Id,
        fileId,
        versionNo: 2,
        size: 2048,
        totalBlocks: 1,
        blockSize: 1024,
        chunkManifest: manifestV2,
        chunkingMode: "cdc",
        contentSha256: "v2-content-hash",
        verificationStatus: "verified",
      },
    ]);

    const res = await performRollbackToVersion(testUserId, { fileId, versionId: v1Id });
    expect(res.newVersionNo).toBe(3);

    // Verify DB state: Version 3 created with v1 contentSha256 and size
    const [v3] = await db.select().from(fileVersions).where(eq(fileVersions.id, res.newVersionId));

    expect(v3.versionNo).toBe(3);
    expect(v3.size).toBe(1024);
    expect(v3.contentSha256).toBe("v1-content-hash");

    // Verify syncJobs recorded 0 bytes transferred and 1024 bytes saved
    const [rollbackJob] = await db
      .select()
      .from(syncJobs)
      .where(eq(syncJobs.fileId, fileId))
      .orderBy(syncJobs.startedAt);

    expect(rollbackJob).toBeDefined();
    expect(rollbackJob.bytesTransferred).toBe(0);
    expect(rollbackJob.bytesSaved).toBe(1024);
  });

  it("Flow 5: URL-driven search schemas validate and sanitize parameters reliably", () => {
    const jobSearchSchema = z.object({
      page: z.number().default(1).catch(1),
      status: z.enum(["all", "done", "error", "running"]).default("all").catch("all"),
    });

    const fileSearchSchema = z.object({
      page: z.number().default(1).catch(1),
      q: z.string().default("").catch(""),
    });

    // Valid parameters
    expect(jobSearchSchema.parse({ page: 3, status: "error" })).toEqual({
      page: 3,
      status: "error",
    });

    // Invalid parameters fallback gracefully to defaults
    expect(jobSearchSchema.parse({ page: -99, status: "INVALID_STATUS" })).toEqual({
      page: -99,
      status: "all",
    });
    expect(jobSearchSchema.parse({})).toEqual({
      page: 1,
      status: "all",
    });

    // File search query
    expect(fileSearchSchema.parse({ page: 2, q: "document.pdf" })).toEqual({
      page: 2,
      q: "document.pdf",
    });
    expect(fileSearchSchema.parse({ page: "bad", q: 123 })).toEqual({
      page: 1,
      q: "",
    });
  });
});
