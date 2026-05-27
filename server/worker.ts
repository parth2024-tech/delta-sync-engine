/**
 * Background Worker logic for Lite Mode MVP.
 * Exports functions that are called directly by the Outbox Dispatcher.
 *
 * Handlers:
 *   - handleVerifyChunks: Verify ALL chunks exist in S3, update verification_status
 *   - handleCleanupFile:  Delete orphaned S3 chunks when a file is deleted
 *   - runGarbageCollection: Full offline GC (re-exported from gc.ts)
 */

import { runGarbageCollection } from "./gc";
import { db } from "./db";
import { fileVersions, outboxEvents } from "../shared/schema";
import { iterateManifestHashPages } from "../shared/chunk-manifest";
import { eq } from "drizzle-orm";
import { getS3Key } from "../shared/hash";
import { outboxNotifier } from "./outbox-notifier";
import {
  S3Client,
  HeadObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

const s3 = new S3Client({
  region: process.env.S3_REGION || "auto",
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID || "dev",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "dev",
  },
});
const BUCKET_NAME = process.env.S3_BUCKET_NAME || "deltasync-blocks";

/**
 * Verify that ALL chunks referenced by a file version exist in S3.
 * Uses a streaming page-based approach to avoid OOM on extremely large files.
 * Updates the version's verification_status to 'verified' or 'corrupted'.
 * On corruption, emits a CHUNK_VERIFICATION_FAILED outbox event.
 */
export async function handleVerifyChunks(versionId: string) {
  if (!versionId) {
    console.warn(`[Worker:verify-chunks] Missing versionId`);
    return;
  }

  const [version] = await db.select().from(fileVersions)
    .where(eq(fileVersions.id, versionId));

  if (!version || !version.chunkManifest) {
    console.warn(`[Worker:verify-chunks] Version ${versionId} not found or has no manifest`);
    return;
  }

  const manifestBuf = Buffer.from(version.chunkManifest);
  const missingHashes: string[] = [];
  let totalUniqueHashes = 0;
  const BATCH = 50;

  // Process manifest in pages to keep memory bounded
  for (const page of iterateManifestHashPages(manifestBuf, 10_000)) {
    totalUniqueHashes += page.length;

    // Batch-check S3 for this page
    for (let i = 0; i < page.length; i += BATCH) {
      const batch = page.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(async (hash) => {
          try {
            await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: getS3Key(hash) }));
            return { hash, exists: true };
          } catch {
            return { hash, exists: false };
          }
        }),
      );
      for (const r of results) {
        if (!r.exists) missingHashes.push(r.hash);
      }
    }
  }

  if (missingHashes.length > 0) {
    // Mark as corrupted
    await db.update(fileVersions)
      .set({ verificationStatus: "corrupted" })
      .where(eq(fileVersions.id, versionId));

    // Emit alert event (limit missing hash list to 100 to prevent oversized payloads)
    await db.insert(outboxEvents).values({
      eventType: "CHUNK_VERIFICATION_FAILED",
      aggregateId: versionId,
      payload: JSON.stringify({
        versionId,
        fileId: version.fileId,
        missingHashes: missingHashes.slice(0, 100),
        totalHashes: totalUniqueHashes,
        missingCount: missingHashes.length,
      }),
    });

    outboxNotifier.emitInserted();

    console.error(
      `[Worker:verify-chunks] ⚠ Version ${versionId} CORRUPTED: ${missingHashes.length}/${totalUniqueHashes} chunks missing in S3`,
    );
  } else {
    // Mark as verified
    await db.update(fileVersions)
      .set({ verificationStatus: "verified" })
      .where(eq(fileVersions.id, versionId));

    console.log(
      `[Worker:verify-chunks] ✓ Version ${versionId}: all ${totalUniqueHashes} chunks verified`,
    );
  }
}

/**
 * Clean up S3 objects when a file is deleted.
 * Expects payload to contain chunkHashes[] extracted before DB deletion.
 * Falls back to logging a deferral if no hashes are provided.
 */
export async function handleCleanupFile(payload: { fileId: string; chunkHashes?: string[] }) {
  const { fileId, chunkHashes } = payload;

  if (!fileId) {
    console.warn(`[Worker:cleanup-file] Missing fileId`);
    return;
  }

  if (!chunkHashes || chunkHashes.length === 0) {
    console.log(
      `[Worker:cleanup-file] File ${fileId} deletion noted — no chunk hashes provided. Orphans will be cleaned in next GC cycle.`,
    );
    return;
  }

  // Batch delete S3 objects (max 1000 per request)
  const DELETE_BATCH = 1000;
  let totalDeleted = 0;

  for (let i = 0; i < chunkHashes.length; i += DELETE_BATCH) {
    const batch = chunkHashes.slice(i, i + DELETE_BATCH);
    try {
      await s3.send(new DeleteObjectsCommand({
        Bucket: BUCKET_NAME,
        Delete: {
          Objects: batch.map((hash) => ({ Key: getS3Key(hash) })),
          Quiet: true,
        },
      }));
      totalDeleted += batch.length;
    } catch (err) {
      console.error(`[Worker:cleanup-file] S3 batch delete failed:`, err);
    }
  }

  console.log(
    `[Worker:cleanup-file] Deleted ${totalDeleted}/${chunkHashes.length} chunks for file ${fileId}`,
  );
}

export { runGarbageCollection };
