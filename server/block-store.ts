/**
 * Phase 1 — Content-addressed block store.
 *
 * Physical block data lives here, keyed by its SHA-256 hex hash.
 * Delegates to pluggable StorageAdapter (S3 or local filesystem).
 */

import { getStorageAdapter } from "./storage-adapter";
import { getS3Key, sha256Hex } from "../shared/hash";
import logger from "pino";

const log = logger({ level: process.env.LOG_LEVEL || "info" });

export class BlockStoreError extends Error {
  constructor(
    public code:
      | "NOT_FOUND"
      | "PERMISSION_DENIED"
      | "SERVER_ERROR"
      | "NETWORK_ERROR"
      | "CORRUPT_BLOCK",
    message: string,
    public originalError?: unknown,
  ) {
    super(message);
    this.name = "BlockStoreError";
  }
}

/** Persist a block. No-op if already stored (content-addressed = immutable). */
export async function storeBlock(hash: string, data: Uint8Array): Promise<void> {
  const computedHash = await sha256Hex(data);
  if (computedHash !== hash) {
    throw new BlockStoreError(
      "CORRUPT_BLOCK",
      `Ingestion strong hash mismatch for block ${hash}: computed ${computedHash}`,
    );
  }

  if (await hasBlock(hash)) {
    return;
  }

  try {
    const adapter = getStorageAdapter();
    await adapter.putObject(getS3Key(hash), data);
    log.debug({ hash, size: data.length }, "Block stored");
  } catch (err: unknown) {
    const error = err as { Code?: string; message?: string };
    log.error({ hash, error: error?.message }, "Failed to store block");

    if (error?.Code === "AccessDenied") {
      throw new BlockStoreError(
        "PERMISSION_DENIED",
        `Permission denied storing block ${hash}`,
        err,
      );
    }

    if (error?.Code === "NoSuchBucket") {
      throw new BlockStoreError("SERVER_ERROR", `Bucket does not exist`, err);
    }

    throw new BlockStoreError(
      "SERVER_ERROR",
      `Failed to store block: ${error?.message || String(err)}`,
      err,
    );
  }
}

/** Retrieve a block by its SHA-256 hash. Throws if not found or corrupted. */
export async function fetchBlock(hash: string): Promise<Uint8Array> {
  try {
    const adapter = getStorageAdapter();
    const buf = await adapter.getObject(getS3Key(hash));
    const computedHash = await sha256Hex(buf);
    if (computedHash !== hash) {
      throw new BlockStoreError(
        "CORRUPT_BLOCK",
        `Bit-rot corruption detected in block ${hash}: computed ${computedHash}`,
      );
    }
    log.debug({ hash, size: buf.length }, "Block fetched and verified");
    return buf;
  } catch (err: unknown) {
    if (err instanceof BlockStoreError) {
      throw err;
    }

    const error = err as { Code?: string; name?: string; message?: string };
    if (
      error?.Code === "NoSuchKey" ||
      error?.name === "NoSuchKey" ||
      error?.message?.includes("not found")
    ) {
      log.warn({ hash }, "Block not found");
      throw new BlockStoreError("NOT_FOUND", `Block ${hash} not found`, err);
    }

    log.error({ hash, error: error?.message }, "Failed to fetch block");

    if (error?.Code === "AccessDenied") {
      throw new BlockStoreError(
        "PERMISSION_DENIED",
        `Permission denied fetching block ${hash}`,
        err,
      );
    }

    throw new BlockStoreError(
      "SERVER_ERROR",
      `Failed to fetch block: ${error?.message || String(err)}`,
      err,
    );
  }
}

/** Check existence without loading the bytes. */
export async function hasBlock(hash: string): Promise<boolean> {
  try {
    const adapter = getStorageAdapter();
    return await adapter.headObject(getS3Key(hash));
  } catch (err: unknown) {
    const error = err as { message?: string };
    log.warn({ hash, error: error?.message }, "Error checking block existence");
    return false;
  }
}

/** Delete a block from storage. */
export async function deleteBlock(hash: string): Promise<void> {
  try {
    const adapter = getStorageAdapter();
    await adapter.deleteObject(getS3Key(hash));
  } catch (err: unknown) {
    const error = err as { message?: string };
    log.warn({ hash, error: error?.message }, "Error deleting block");
  }
}
