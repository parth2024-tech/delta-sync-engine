/**
 * Database-backed negotiation store for distributed deployments.
 *
 * Supports resumable uploads:
 *   - getNegotiation() reads without consuming (allows retries)
 *   - clearNegotiation() explicitly consumes after successful commit
 *   - TTL-based cleanup (1 hour, matches pre-signed URL expiry)
 *   - Supports horizontal scaling across multi-node replicas
 */

import { db } from "./db";
import { negotiations } from "../shared/schema";
import { eq, lt } from "drizzle-orm";

export interface NegotiationPayload {
  userId: string;
  path: string;
  chunking: "cdc" | "fixed";
  blockSize: number;
  newSize: number;
  contentSha256: string;
  chunks: { strongHash: string; length: number; weakHash?: number }[];
  missingChunkHashes?: string[];
  snapshotCurrentVersionId: string | null;
}

const NEGOTIATION_TTL_MS = 60 * 60 * 1000; // 1 hour (matches pre-signed URL expiry)

export async function setNegotiation(id: string, payload: NegotiationPayload): Promise<void> {
  const expiresAt = new Date(Date.now() + NEGOTIATION_TTL_MS);

  // Pack chunks and missingChunkHashes
  const packedChunks = Buffer.from(
    JSON.stringify({
      chunks: payload.chunks,
      missingChunkHashes: payload.missingChunkHashes,
    }),
  );

  await db
    .insert(negotiations)
    .values({
      id,
      userId: payload.userId,
      path: payload.path,
      chunking: payload.chunking,
      blockSize: payload.blockSize,
      newSize: payload.newSize,
      contentSha256: payload.contentSha256,
      chunks: packedChunks,
      snapshotVersionId: payload.snapshotCurrentVersionId,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: negotiations.id,
      set: {
        path: payload.path,
        chunking: payload.chunking,
        blockSize: payload.blockSize,
        newSize: payload.newSize,
        contentSha256: payload.contentSha256,
        chunks: packedChunks,
        snapshotVersionId: payload.snapshotCurrentVersionId,
        expiresAt,
      },
    });
}

/**
 * Read a negotiation without consuming it.
 * The negotiation remains valid for retries if commit fails.
 */
export async function getNegotiation(id: string): Promise<NegotiationPayload | null> {
  const rows = await db.select().from(negotiations).where(eq(negotiations.id, id)).limit(1);

  const entry = rows[0];
  if (!entry) return null;

  // Check expiration
  const expiresAtMs =
    entry.expiresAt instanceof Date ? entry.expiresAt.getTime() : Number(entry.expiresAt);
  if (expiresAtMs < Date.now()) {
    await db.delete(negotiations).where(eq(negotiations.id, id));
    return null;
  }

  // Reconstruct payload
  const rawData = JSON.parse(entry.chunks!.toString("utf-8"));
  const chunks = Array.isArray(rawData) ? rawData : rawData.chunks;
  const missingChunkHashes = Array.isArray(rawData) ? undefined : rawData.missingChunkHashes;

  return {
    userId: entry.userId,
    path: entry.path,
    chunking: entry.chunking as "cdc" | "fixed",
    blockSize: entry.blockSize,
    newSize: entry.newSize,
    contentSha256: entry.contentSha256,
    chunks,
    missingChunkHashes,
    snapshotCurrentVersionId: entry.snapshotVersionId,
  };
}

/**
 * Consume and remove a negotiation after successful commit.
 */
export async function clearNegotiation(id: string): Promise<void> {
  await db.delete(negotiations).where(eq(negotiations.id, id));
}

/**
 * Legacy one-shot: read and clear in a single call.
 * @deprecated Use getNegotiation + clearNegotiation for resumable uploads.
 */
export async function getAndClearNegotiation(id: string): Promise<NegotiationPayload | null> {
  const payload = await getNegotiation(id);
  if (payload) await clearNegotiation(id);
  return payload;
}

/**
 * Cleanup expired entries.
 * Safe to call repeatedly - only deletes expired records.
 */
export async function cleanupExpiredNegotiations(): Promise<void> {
  await db.delete(negotiations).where(lt(negotiations.expiresAt, new Date()));
}

// Schedule periodic cleanup
setInterval(async () => {
  try {
    await cleanupExpiredNegotiations();
  } catch (err) {
    console.error("[NegotiationStore] Cleanup error:", err);
  }
}, 60000).unref();
