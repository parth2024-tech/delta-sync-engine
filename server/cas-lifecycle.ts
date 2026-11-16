import { db } from "./db";
import { casBlockIndex } from "../shared/schema";
import { getStorageAdapter } from "./storage-adapter";
import { eq, lte, and, sql } from "drizzle-orm";
import { getS3Key } from "../shared/hash";

const DEFAULT_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000; // 24-hour quarantine before physical purge

export class CasLifecycleManager {
  /**
   * Increments ref_counts for newly committed version chunks.
   * Uses an atomic upsert to either register a new hash with ref_count=1,
   * or increment the existing ref_count and refresh last_referenced_at.
   */
  public static async registerReferences(
    hashesWithSizes: { hash: string; size: number }[],
  ): Promise<void> {
    if (hashesWithSizes.length === 0) return;

    for (const { hash, size } of hashesWithSizes) {
      await db
        .insert(casBlockIndex)
        .values({
          strongHash: hash,
          byteSize: size,
          refCount: 1,
          firstSeenAt: new Date(),
          lastReferencedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: casBlockIndex.strongHash,
          set: {
            refCount: sql`${casBlockIndex.refCount} + 1`,
            lastReferencedAt: new Date(),
          },
        });
    }
  }

  /**
   * Decrements ref_counts when an older file version is pruned or deleted.
   * Saturates at 0 so ref_counts never become negative.
   */
  public static async dereference(hashes: string[]): Promise<void> {
    if (hashes.length === 0) return;

    for (const hash of hashes) {
      await db
        .update(casBlockIndex)
        .set({
          refCount: sql`MAX(0, ${casBlockIndex.refCount} - 1)`,
          lastReferencedAt: new Date(),
        })
        .where(eq(casBlockIndex.strongHash, hash));
    }
  }

  /**
   * Sweeps zero-reference blocks exceeding grace period without full storage scans.
   */
  public static async sweepQuarantinedBlocks(
    gracePeriodMs: number = DEFAULT_GRACE_PERIOD_MS,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - gracePeriodMs);
    const storage = getStorageAdapter();

    const candidateRows = await db
      .select()
      .from(casBlockIndex)
      .where(and(lte(casBlockIndex.refCount, 0), lte(casBlockIndex.lastReferencedAt, cutoff)))
      .limit(1000);

    if (candidateRows.length === 0) return 0;

    let deletedCount = 0;
    for (const row of candidateRows) {
      try {
        await storage.deleteObject(getS3Key(row.strongHash));
        await db.delete(casBlockIndex).where(eq(casBlockIndex.strongHash, row.strongHash));
        deletedCount++;
      } catch (err) {
        console.error(`[CAS:GC] Failed to delete orphan block ${row.strongHash}:`, err);
      }
    }

    return deletedCount;
  }
}
