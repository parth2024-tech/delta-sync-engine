/**
 * Database-backed negotiation store for distributed deployments.
 *
 * Supports resumable uploads:
 *   - getNegotiation() reads without consuming (allows retries)
 *   - clearNegotiation() explicitly consumes after successful commit
 *   - TTL-based cleanup (1 hour, matches pre-signed URL expiry)
 *   - Supports horizontal scaling (shared database backend)
 */

import { db } from "./db";
import { negotiations } from "../shared/schema";
import { eq, lt, and, desc } from "drizzle-orm";

export interface NegotiationPayload {
  userId: string;
  path: string;
  chunking: "cdc" | "fixed";
  blockSize: number;
  newSize: number;
  contentSha256: string;
  chunks: { strongHash: string; length: number; weakHash?: number }[];
  snapshotCurrentVersionId: string | null;
}

const NEGOTIATION_TTL_MS = 60 * 60 * 1000; // 1 hour (matches pre-signed URL expiry)

export async function setNegotiation(
  id: string,
  payload: NegotiationPayload,
): Promise<void> {
  const expiresAt = new Date(Date.now() + NEGOTIATION_TTL_MS);

  // Pack chunks as binary format for efficient storage
  const packedChunks = Buffer.from(JSON.stringify(payload.chunks));

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
      expiresAt: expiresAt.getTime(),
    })
    .run();
}

/**
 * Read a negotiation without consuming it.
 * The negotiation remains valid for retries if commit fails.
 */
export async function getNegotiation(
  id: string,
): Promise<NegotiationPayload | null> {
  const entry = await db
    .select()
    .from(negotiations)
    .where(eq(negotiations.id, id))
    .get();

  if (!entry) return null;

  // Check expiration
  if (entry.expiresAt < Date.now()) {
    await db.delete(negotiations).where(eq(negotiations.id, id)).run();
    return null;
  }

  // Reconstruct payload
  const chunks = JSON.parse(entry.chunks!.toString());
  return {
    userId: entry.userId,
    path: entry.path,
    chunking: entry.chunking as "cdc" | "fixed",
    blockSize: entry.blockSize,
    newSize: entry.newSize,
    contentSha256: entry.contentSha256,
    chunks,
    snapshotCurrentVersionId: entry.snapshotVersionId,
  };
}

/**
 * Consume and remove a negotiation after successful commit.
 */
export async function clearNegotiation(id: string): Promise<void> {
  await db.delete(negotiations).where(eq(negotiations.id, id)).run();
}

/**
 * Legacy one-shot: read and clear in a single call.
 * @deprecated Use getNegotiation + clearNegotiation for resumable uploads.
 */
export async function getAndClearNegotiation(
  id: string,
): Promise<NegotiationPayload | null> {
  const payload = await getNegotiation(id);
  if (payload) await clearNegotiation(id);
  return payload;
}

/**
 * Cleanup expired entries.
 * Safe to call repeatedly - only deletes expired records.
 */
export async function cleanupExpiredNegotiations(): Promise<number> {
  const result = await db
    .delete(negotiations)
    .where(lt(negotiations.expiresAt, Date.now()))
    .run();
  return result.changes;
}

// Schedule periodic cleanup
setInterval(async () => {
  try {
    await cleanupExpiredNegotiations();
  } catch (err) {
    console.error("[NegotiationStore] Cleanup error:", err);
  }
}, 60000).unref();
