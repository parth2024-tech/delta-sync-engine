/**
 * Phase 1 — Content-addressed block store.
 *
 * Physical block data lives here, keyed by its SHA-256 hex hash.
 * In development this is a local directory; swap the adapter for S3/R2 in prod.
 *
 * Uses singleton S3 client for connection pooling.
 * Proper error handling distinguishes between 404 (not found) and other errors.
 */

import {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
} from "@aws-sdk/client-s3";
import { getS3Client } from "./s3-client";
import { getS3Key } from "../shared/hash";
import logger from "pino";

const log = logger();
const BUCKET_NAME = process.env.S3_BUCKET_NAME || "deltasync-blocks";

class BlockStoreError extends Error {
  constructor(
    public code: "NOT_FOUND" | "PERMISSION_DENIED" | "SERVER_ERROR" | "NETWORK_ERROR",
    message: string,
    public originalError?: Error,
  ) {
    super(message);
    this.name = "BlockStoreError";
  }
}

/** Persist a block. No-op if already stored (content-addressed = immutable). */
export async function storeBlock(hash: string, data: Uint8Array): Promise<void> {
  if (await hasBlock(hash)) {
    return;
  }

  try {
    const s3 = getS3Client();
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: getS3Key(hash),
        Body: data,
        ContentLength: data.length,
      }),
    );
    log.debug({ hash, size: data.length }, "Block stored");
  } catch (err) {
    const error = err as any;
    log.error({ hash, error: error.message }, "Failed to store block");

    if (error.Code === "AccessDenied") {
      throw new BlockStoreError(
        "PERMISSION_DENIED",
        `Permission denied storing block ${hash}`,
        error,
      );
    }

    if (error.Code === "NoSuchBucket") {
      throw new BlockStoreError(
        "SERVER_ERROR",
        `S3 bucket ${BUCKET_NAME} does not exist`,
        error,
      );
    }

    throw new BlockStoreError(
      "SERVER_ERROR",
      `Failed to store block: ${error.message}`,
      error,
    );
  }
}

/** Retrieve a block by its SHA-256 hash. Throws if not found. */
export async function fetchBlock(hash: string): Promise<Uint8Array> {
  try {
    const s3 = getS3Client();
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: getS3Key(hash),
      }),
    );

    const buf = await response.Body?.transformToByteArray();
    if (!buf) {
      throw new BlockStoreError(
        "NOT_FOUND",
        `Block ${hash} returned empty body`,
      );
    }

    log.debug({ hash, size: buf.length }, "Block fetched");
    return buf;
  } catch (err) {
    if (err instanceof NoSuchKey) {
      log.warn({ hash }, "Block not found");
      throw new BlockStoreError("NOT_FOUND", `Block ${hash} not found`, err);
    }

    const error = err as any;
    if (error instanceof BlockStoreError) {
      throw error;
    }

    log.error({ hash, error: error.message }, "Failed to fetch block");

    if (error.Code === "AccessDenied") {
      throw new BlockStoreError(
        "PERMISSION_DENIED",
        `Permission denied fetching block ${hash}`,
        error,
      );
    }

    throw new BlockStoreError(
      "SERVER_ERROR",
      `Failed to fetch block: ${error.message}`,
      error,
    );
  }
}

/** Check existence without loading the bytes. */
export async function hasBlock(hash: string): Promise<boolean> {
  try {
    const s3 = getS3Client();
    await s3.send(
      new HeadObjectCommand({
        Bucket: BUCKET_NAME,
        Key: getS3Key(hash),
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof NoSuchKey) {
      return false;
    }

    const error = err as any;
    if (error.Code === "NotFound" || error.Code === "NoSuchKey") {
      return false;
    }

    // Log but don't fail - treat other errors as "not found"
    log.warn({ hash, error: error.message }, "Error checking block existence");
    return false;
  }
}
