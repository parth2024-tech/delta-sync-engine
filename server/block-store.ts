/**
 * Phase 1 — Content-addressed block store.
 *
 * Physical block data lives here, keyed by its SHA-256 hex hash.
 * In development this is a local directory; swap the adapter for S3/R2 in prod.
 */

import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  region: process.env.S3_REGION || "auto",
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID || "dev",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "dev",
  },
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME || "deltasync-blocks";

/** Persist a block. No-op if already stored (content-addressed = immutable). */
export async function storeBlock(hash: string, data: Uint8Array): Promise<void> {
  if (await hasBlock(hash)) {
    return;
  }
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: hash,
    Body: data,
  }));
}

/** Retrieve a block by its SHA-256 hash. Throws if not found. */
export async function fetchBlock(hash: string): Promise<Uint8Array> {
  const response = await s3.send(new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: hash,
  }));
  const buf = await response.Body?.transformToByteArray();
  if (!buf) throw new Error("Block not found");
  return buf;
}

/** Check existence without loading the bytes. */
export async function hasBlock(hash: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({
      Bucket: BUCKET_NAME,
      Key: hash,
    }));
    return true;
  } catch {
    return false;
  }
}
