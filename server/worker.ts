/**
 * Background Worker logic for Lite Mode MVP.
 * Exports functions that are called directly by the Outbox Dispatcher.
 */

import { runGarbageCollection } from "./gc";
import { db } from "./db";
import { fileVersions } from "../shared/schema";
import { decodeChunkManifestV1 } from "../shared/chunk-manifest";
import { eq } from "drizzle-orm";
import {
  S3Client,
  HeadObjectCommand,
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
  } else {
    console.log(
      `[Worker:verify-chunks] ✓ Version ${versionId}: all ${uniqueHashes.length} chunks verified`,
    );
  }
}

export async function handleCleanupFile(fileId: string) {
  if (!fileId) {
    console.warn(`[Worker:cleanup-file] Missing fileId`);
    return;
  }
  console.log(`[Worker:cleanup-file] File ${fileId} deletion noted. Orphans will be cleaned in next GC cycle.`);
}

export { runGarbageCollection };
