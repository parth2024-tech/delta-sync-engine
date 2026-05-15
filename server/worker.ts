/**
 * Background Worker — Processes jobs dispatched by the Outbox Dispatcher.
 *
 * Handles event-driven jobs:
 *   - verify-chunks     — Verify all chunks exist in S3 after upload commit
 *   - cleanup-file      — Clean up S3 objects when a file is deleted
 *   - run-gc            — Run garbage collection (Roaring Bitmap-based)
 *
 * This worker is extensible: add new event handlers for RAG indexing,
 * vector embeddings, webhook notifications, etc.
 *
 * Run: npx tsx --env-file=.env server/worker.ts
 */

import { Worker, type Job } from "bullmq";
import Redis from "ioredis";
import { runGarbageCollection } from "./gc";
import { db } from "./db";
import { fileVersions } from "../shared/schema";
import { decodeChunkManifestV1 } from "../shared/chunk-manifest";
import { eq } from "drizzle-orm";
import {
  S3Client,
  HeadObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

const redisConnection = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

const s3 = new S3Client({
  region: process.env.S3_REGION || "auto",
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID || "dev",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "dev",
  },
});
const BUCKET_NAME = process.env.S3_BUCKET_NAME || "deltasync-blocks";

// ── Job Handlers ──────────────────────────────────────────────────────────────

/**
 * Verify that all chunks referenced by a file version actually exist in S3.
 * This runs asynchronously after the upload commit, so it never blocks the client.
 */
async function handleVerifyChunks(job: Job) {
  const { versionId } = job.data;
  if (!versionId) {
    console.warn(`[Worker:verify-chunks] Missing versionId in job ${job.id}`);
    return;
  }

  const [version] = await db.select().from(fileVersions)
    .where(eq(fileVersions.id, versionId));

  if (!version || !version.chunkManifest) {
    console.warn(`[Worker:verify-chunks] Version ${versionId} not found or has no manifest`);
    return;
  }

  const chunks = decodeChunkManifestV1(Buffer.from(version.chunkManifest));
  const uniqueHashes = [...new Set(chunks.map((c) => c.strongHashHex))];

  let missing = 0;
  const BATCH = 50;
  for (let i = 0; i < uniqueHashes.length; i += BATCH) {
    const batch = uniqueHashes.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (hash) => {
        try {
          await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: hash }));
          return true;
        } catch {
          return false;
        }
      }),
    );
    missing += results.filter((ok) => !ok).length;
  }

  if (missing > 0) {
    console.error(
      `[Worker:verify-chunks] ⚠ Version ${versionId} has ${missing}/${uniqueHashes.length} missing chunks in S3!`,
    );
    // In production, you would emit an alert / mark the version as corrupted
  } else {
    console.log(
      `[Worker:verify-chunks] ✓ Version ${versionId}: all ${uniqueHashes.length} chunks verified`,
    );
  }
}

/**
 * Clean up S3 objects when a file is deleted.
 * Collects all unique chunk hashes across all versions and deletes orphaned ones.
 */
async function handleCleanupFile(job: Job) {
  const { fileId } = job.data;
  if (!fileId) {
    console.warn(`[Worker:cleanup-file] Missing fileId in job ${job.id}`);
    return;
  }

  // This is handled by the GC process — file deletion cascades in the DB,
  // and the next GC run will pick up orphaned S3 objects.
  console.log(`[Worker:cleanup-file] File ${fileId} deletion noted. Orphans will be cleaned in next GC cycle.`);
}

// ── Worker Setup ──────────────────────────────────────────────────────────────

export const backgroundWorker = new Worker("background-jobs", async (job) => {
  const start = Date.now();
  console.log(`[Worker] Processing job ${job.id} (${job.name})...`);

  switch (job.name) {
    case "run-gc":
      await runGarbageCollection();
      break;

    case "verify-chunks":
      await handleVerifyChunks(job);
      break;

    case "cleanup-file":
      await handleCleanupFile(job);
      break;

    default:
      console.warn(`[Worker] Unknown job type: ${job.name}`);
  }

  console.log(`[Worker] Job ${job.id} (${job.name}) completed in ${Date.now() - start}ms`);
}, {
  connection: redisConnection,
  concurrency: 3, // Process up to 3 jobs in parallel
});

backgroundWorker.on("completed", (job) => {
  console.log(`[Worker] ✓ Job ${job.id} completed`);
});

backgroundWorker.on("failed", (job, err) => {
  console.error(`[Worker] ✗ Job ${job?.id} failed: ${err.message}`);
});

backgroundWorker.on("error", (err) => {
  console.error("[Worker] Worker error:", err);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("[Worker] Shutting down...");
  await backgroundWorker.close();
  await redisConnection.quit();
  process.exit(0);
});

console.log("[Worker] Background worker started, listening on 'background-jobs' queue (concurrency: 3)");
