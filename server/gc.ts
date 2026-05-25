/**
 * Offline Garbage Collection — S3 Inventory + Roaring Bitmap reconciliation.
 *
 * Architecture:
 *   1. Stream chunk_manifest from the database in pages (bounded memory)
 *   2. Build a compressed hash set (simulated Roaring Bitmap) of all referenced
 *      SHA-256 hashes — O(1) memory relative to bucket size
 *   3. Stream S3 object listing and cross-reference against the hash set
 *   4. Batch-delete orphaned objects
 *
 * The core transactional database experiences zero load during the S3
 * reconciliation phase. GC runs are tracked in the `gc_runs` table.
 *
 * Run: npx tsx --env-file=.env server/gc.ts
 */

import { S3Client, ListObjectsV2Command, DeleteObjectsCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { db } from "./db";
import { gcRuns, blocks, fileVersions } from "../shared/schema";
import { decodeChunkManifestV1 } from "../shared/chunk-manifest";
import { eq, gt, asc, isNotNull } from "drizzle-orm";
import { getS3Key } from "../shared/hash";

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
const INVENTORY_BUCKET = process.env.S3_INVENTORY_BUCKET || "";
const INVENTORY_KEY = process.env.S3_INVENTORY_KEY || "";

// ── Roaring Bitmap Simulation ─────────────────────────────────────────────────

/**
 * Compressed hash set using prefix-bucketed Sets.
 * For 64-char hex SHA-256 hashes, we bucket by the first 2 hex chars (256 buckets).
 * Each bucket stores only the remaining 62 chars, saving ~3% memory per entry
 * and enabling fast membership testing via prefix dispatch.
 */
class CompressedHashSet {
  private buckets: Map<string, Set<string>> = new Map();
  private _size = 0;

  add(hash: string): void {
    const prefix = hash.substring(0, 2);
    const suffix = hash.substring(2);
    let bucket = this.buckets.get(prefix);
    if (!bucket) {
      bucket = new Set();
      this.buckets.set(prefix, bucket);
    }
    const prevSize = bucket.size;
    bucket.add(suffix);
    if (bucket.size > prevSize) this._size++;
  }

  has(hash: string): boolean {
    const prefix = hash.substring(0, 2);
    const bucket = this.buckets.get(prefix);
    return bucket ? bucket.has(hash.substring(2)) : false;
  }

  get size(): number {
    return this._size;
  }

  clear(): void {
    this.buckets.clear();
    this._size = 0;
  }
}

// ── Phase 1: Build reference set from database ────────────────────────────────

export async function buildReferenceSet(): Promise<CompressedHashSet> {
  const hashSet = new CompressedHashSet();

  // Collect legacy block hashes using Drizzle
  const BLOCK_PAGE = 5000;
  let blockOffset = 0;
  for (;;) {
    const rows = await db.select({ strongHash: blocks.strongHash })
      .from(blocks)
      .limit(BLOCK_PAGE)
      .offset(blockOffset);
    for (const row of rows) {
      hashSet.add(row.strongHash);
    }
    if (rows.length < BLOCK_PAGE) break;
    blockOffset += BLOCK_PAGE;
  }
  console.log(`[GC] Phase 1a: Indexed ${hashSet.size} legacy block hashes`);

  // Stream chunk manifests in pages (cursor-based using id ordering)
  let lastId = "";
  let versionsSeen = 0;
  const PAGE_SIZE = 80;

  for (;;) {
    const rows = lastId === ""
      ? await db.select({ id: fileVersions.id, chunkManifest: fileVersions.chunkManifest })
          .from(fileVersions)
          .where(isNotNull(fileVersions.chunkManifest))
          .orderBy(asc(fileVersions.id))
          .limit(PAGE_SIZE)
      : await db.select({ id: fileVersions.id, chunkManifest: fileVersions.chunkManifest })
          .from(fileVersions)
          .where(gt(fileVersions.id, lastId))
          .orderBy(asc(fileVersions.id))
          .limit(PAGE_SIZE);

    if (rows.length === 0) break;

    for (const row of rows) {
      lastId = row.id;
      versionsSeen++;
      try {
        if (row.chunkManifest) {
          const chunks = decodeChunkManifestV1(Buffer.from(row.chunkManifest));
          for (const chunk of chunks) {
            hashSet.add(chunk.strongHashHex);
          }
        }
      } catch {
        // Skip corrupted manifests
        console.warn(`[GC] Skipping corrupted manifest for version ${row.id}`);
      }
    }

    if (rows.length < PAGE_SIZE) break;
  }

  console.log(`[GC] Phase 1b: Processed ${versionsSeen} version manifests → ${hashSet.size} total unique hashes`);

  return hashSet;
}

// ── Phase 2: Reconcile S3 against the reference set ───────────────────────────

async function reconcileWithS3Listing(hashSet: CompressedHashSet): Promise<number> {
  throw new Error("[GC] ListObjectsV2 is entirely disabled for scaling. S3 Inventory CSV reports must be used.");
}

/**
 * Reconcile using S3 Inventory CSV (for large buckets with millions of objects).
 */
async function reconcileWithInventory(hashSet: CompressedHashSet): Promise<number> {
  if (!INVENTORY_BUCKET || !INVENTORY_KEY) {
    throw new Error("[GC] ListObjectsV2 is entirely disabled for scaling. S3 Inventory (INVENTORY_BUCKET & INVENTORY_KEY) must be configured to run GC.");
  }

  let deletedCount = 0;
  console.log(`[GC] Reading S3 Inventory from s3://${INVENTORY_BUCKET}/${INVENTORY_KEY}`);

  try {
    const response = await s3.send(new GetObjectCommand({
      Bucket: INVENTORY_BUCKET,
      Key: INVENTORY_KEY,
    }));

    const body = await response.Body?.transformToString();
    if (!body) {
      throw new Error("[GC] Empty S3 Inventory report received.");
    }

    const orphanedKeys: string[] = [];
    const lines = body.split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;
      const parts = line.split(",");
      const key = parts[1]?.replace(/"/g, "").trim();
      if (!key || key.startsWith("temp-")) continue;

      // Map prefix-sharded S3 Key back to its raw strong hash
      const rawHash = key.includes("/") ? key.split("/").pop()! : key;

      if (!hashSet.has(rawHash)) {
        orphanedKeys.push(key);
      }
    }

    // Batch delete
    const DELETE_BATCH = 1000;
    for (let i = 0; i < orphanedKeys.length; i += DELETE_BATCH) {
      const batch = orphanedKeys.slice(i, i + DELETE_BATCH);
      await s3.send(new DeleteObjectsCommand({
        Bucket: BUCKET_NAME,
        Delete: { Objects: batch.map((Key) => ({ Key: getS3Key(Key) })), Quiet: true },
      }));
      deletedCount += batch.length;
    }

    console.log(`[GC] Inventory: processed ${lines.length} entries, deleted ${deletedCount} orphans`);
  } catch (err) {
    console.error("[GC] Failed to execute S3 Inventory GC:", err);
    throw err;
  }

  return deletedCount;
}

// ── Main GC Orchestrator ──────────────────────────────────────────────────────

export async function runGarbageCollection() {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Starting Offline Garbage Collection (Roaring Bitmap strategy)...");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Track GC run
  const [gcRun] = await db.insert(gcRuns).values({
    status: "running",
  }).returning();

  const startTime = Date.now();

  try {
    // Phase 1: Build reference set from database (all referenced chunk hashes)
    const hashSet = await buildReferenceSet();

    // Phase 2: Reconcile S3 against the reference set
    const deletedCount = await reconcileWithInventory(hashSet);

    // Clean up the hash set memory
    hashSet.clear();

    const elapsedMs = Date.now() - startTime;

    // Update GC run record
    await db.update(gcRuns)
      .set({
        status: "completed",
        deletedCount,
        finishedAt: new Date(),
      })
      .where(eq(gcRuns.id, gcRun.id));

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`GC completed in ${(elapsedMs / 1000).toFixed(1)}s — deleted ${deletedCount} orphaned objects`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  } catch (e) {
    const elapsedMs = Date.now() - startTime;
    console.error(`[GC] Fatal error after ${(elapsedMs / 1000).toFixed(1)}s:`, e);

    await db.update(gcRuns)
      .set({
        status: "failed",
        error: String(e),
        finishedAt: new Date(),
      })
      .where(eq(gcRuns.id, gcRun.id));

    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGarbageCollection().catch(console.error).finally(() => process.exit(0));
}
