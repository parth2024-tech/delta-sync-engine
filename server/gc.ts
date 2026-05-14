import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { db } from "./db";
import { blocks, fileVersions } from "../shared/schema";
import { decodeChunkManifestV1 } from "../shared/chunk-manifest";

const s3 = new S3Client({
  region: process.env.S3_REGION || "auto",
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID || "dev",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "dev",
  },
});
const BUCKET_NAME = process.env.S3_BUCKET_NAME || "deltasync-blocks";

async function collectReferencedStrongHashes(): Promise<Set<string>> {
  const set = new Set<string>();

  const manifests = await db.select({ m: fileVersions.chunkManifest }).from(fileVersions);
  for (const row of manifests) {
    if (!row.m) continue;
    try {
      for (const c of decodeChunkManifestV1(Buffer.from(row.m))) {
        set.add(c.strongHashHex);
      }
    } catch {
      /* skip corrupt manifest */
    }
  }

  const legacy = await db.select({ h: blocks.strongHash }).from(blocks);
  for (const { h } of legacy) set.add(h);

  return set;
}

export async function runGarbageCollection() {
  console.log("Starting S3 Garbage Collection...");
  const referenced = await collectReferencedStrongHashes();

  let continuationToken: string | undefined;
  let deletedCount = 0;

  do {
    const listResponse = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      ContinuationToken: continuationToken,
    }));

    if (!listResponse.Contents || listResponse.Contents.length === 0) break;

    const keys = listResponse.Contents.map((obj) => obj.Key!).filter((key) => !key.startsWith("temp-"));
    const tempKeys = listResponse.Contents
      .filter((obj) => obj.Key?.startsWith("temp-") && obj.LastModified && (Date.now() - obj.LastModified.getTime() > 24 * 60 * 60 * 1000))
      .map((obj) => obj.Key!);

    if (keys.length > 0) {
      const CHUNK_SIZE = 100;
      for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
        const chunk = keys.slice(i, i + CHUNK_SIZE);
        const deleteChunk = chunk.filter((k) => !referenced.has(k));
        if (deleteChunk.length > 0) {
          await s3.send(new DeleteObjectsCommand({
            Bucket: BUCKET_NAME,
            Delete: { Objects: deleteChunk.map((Key) => ({ Key })), Quiet: true },
          }));
          deletedCount += deleteChunk.length;
        }
      }
    }

    if (tempKeys.length > 0) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: BUCKET_NAME,
        Delete: { Objects: tempKeys.map((Key) => ({ Key })), Quiet: true },
      }));
      deletedCount += tempKeys.length;
    }

    continuationToken = listResponse.NextContinuationToken;
  } while (continuationToken);

  console.log(`Garbage Collection finished. Deleted ${deletedCount} orphaned objects.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGarbageCollection().catch(console.error).finally(() => process.exit(0));
}
