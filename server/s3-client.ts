/**
 * Singleton S3 client instance.
 *
 * Ensures a single S3Client is reused across all modules,
 * improving performance through connection pooling and reducing overhead.
 *
 * All modules should import s3Client from this file instead of
 * creating their own instances.
 */

import { S3Client } from "@aws-sdk/client-s3";

let instance: S3Client | null = null;

export function getS3Client(): S3Client {
  if (!instance) {
    instance = new S3Client({
      region: process.env.S3_REGION || "auto",
      endpoint: process.env.S3_ENDPOINT,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
      },
    });
  }
  return instance;
}

export async function closeS3Client(): Promise<void> {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}
