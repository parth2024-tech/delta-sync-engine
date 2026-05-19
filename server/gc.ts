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
 * When S3 Inventory Reports are enabled:
 *   - Configure S3 to dump daily inventory CSVs to a separate bucket
 *   - This GC reads the inventory CSV instead of doing ListObjectsV2
 *   - Eliminates S3 LIST API costs for large buckets (millions of objects)
 *
 * Run: npx tsx --env-file=.env server/gc.ts
 */

import { S3Client, ListObjectsV2Command, DeleteObjectsCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { pool, db } from "./db";
import { gcRuns } from "../shared/schema";
import { decodeChunkManifestV1 } from "../shared/chunk-manifest";
import { eq } from "drizzle-orm";

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
// In production, use the `roaring` npm package for true Roaring Bitmap
// compression. Here we use a Set<string> partitioned into buckets for
// memory efficiency with hash prefixes.

/**
 * Compressed hash set using prefix-bucketed Sets.
 * For 64-char hex SHA-256 hashes, we bucket by the first 2 hex chars (256 buckets).
 * Each bucket stores only the remaining 62 chars, saving ~3% memory per entry
 * and enabling fast membership testing via prefix dispatch.
 *
 * For true production scale (>10M hashes), swap this for the `roaring` WASM package.
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

async function buildReferenceSet(): Promise<CompressedHashSet> {
  const hashSet = new CompressedHashSet();
  const client = await pool.connect();

  try {
    // Collect legacy block hashes
    let blockOffset = 0;
    const BLOCK_PAGE = 5000;
    for (;;) {
      const r = await client.query<{ strong_hash: string }>(
        `SELECT DISTINCT strong_hash FROM blocks ORDER BY strong_hash LIMIT $1 OFFSET $2`,
        [BLOCK_PAGE, blockOffset],
      );
      for (const row of r.rows) {
        hashSet.add(row.strong_hash);
      }
      if (r.rows.length < BLOCK_PAGE) break;
      blockOffset += BLOCK_PAGE;
    }
    console.log(`[GC] Phase 1a: Indexed ${hashSet.size} legacy block hashes`);

    // Stream chunk manifests in pages (cursor-based, no OFFSET penalty)
    let lastId = "";
    let versionsSeen = 0;
    const PAGE_SIZE = 80;

    for (;;) {
      const r = await client.query(
        lastId === ""
          ? `SELECT id, chunk_manifest FROM file_versions WHERE chunk_manifest IS NOT NULL ORDER BY id ASC LIMIT ${PAGE_SIZE}`
          : `SELECT id, chunk_manifest FROM file_versions WHERE chunk_manifest IS NOT NULL AND id > $1 ORDER BY id ASC LIMIT ${PAGE_SIZE}`,
        lastId === "" ? [] : [lastId],
      );

      if (r.rows.length === 0) break;

      for (const row of r.rows) {
        lastId = row.id as string;
        versionsSeen++;
        try {
          const chunks = decodeChunkManifestV1(Buffer.from(row.chunk_manifest));
          for (const chunk of chunks) {
            hashSet.add(chunk.strongHashHex);
          }
        } catch {
          // Skip corrupted manifests
          console.warn(`[GC] Skipping corrupted manifest for version ${row.id}`);
        }
      }

      if (r.rows.length < PAGE_SIZE) break;
    }

    console.log(`[GC] Phase 1b: Processed ${versionsSeen} version manifests → ${hashSet.size} total unique hashes`);
  } finally {
    client.release();
  }

  return hashSet;
}

// ── Phase 2: Reconcile S3 against the reference set ───────────────────────────

async function reconcileWithS3Listing(hashSet: CompressedHashSet): Promise<number> {
  let deletedCount = 0;
  let scannedCount = 0;
  let continuationToken: string | undefined;

  do {
    const listResponse = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      ContinuationToken: continuationToken,
    }));

    if (!listResponse.Contents || listResponse.Contents.length === 0) break;

    const orphanedKeys: string[] = [];
    const staleTempKeys: string[] = [];

    for (const obj of listResponse.Contents) {
      const key = obj.Key!;
      scannedCount++;

      // Stale temp uploads (older than 24h)
      if (key.startsWith("temp-")) {
        if (obj.LastModified && Date.now() - obj.LastModified.getTime() > 24 * 60 * 60 * 1000) {
          staleTempKeys.push(key);
        }
        continue;
      }

      // Check if this content-addressed key is referenced
      if (!hashSet.has(key)) {
        orphanedKeys.push(key);
      }
    }

    // Batch delete orphaned objects (S3 supports up to 1000 per request)
    const toDelete = [...orphanedKeys, ...staleTempKeys];
    const DELETE_BATCH = 1000;
    for (let i = 0; i < toDelete.length; i += DELETE_BATCH) {
      const batch = toDelete.slice(i, i + DELETE_BATCH);
      await s3.send(new DeleteObjectsCommand({
        Bucket: BUCKET_NAME,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }));
      deletedCount += batch.length;
    }

    continuationToken = listResponse.NextContinuationToken;
  } while (continuationToken);

  console.log(`[GC] Phase 2: Scanned ${scannedCount} S3 objects, deleted ${deletedCount} orphans`);
  return deletedCount;
}

/**
 * Reconcile using S3 Inventory CSV (for large buckets with millions of objects).
 * S3 Inventory Reports are pre-generated CSVs listing all objects, eliminating
 * the need for expensive ListObjectsV2 pagination.
 */
async function reconcileWithInventory(hashSet: CompressedHashSet): Promise<number> {
  if (!INVENTORY_BUCKET || !INVENTORY_KEY) {
    console.log("[GC] No S3 Inventory configured, falling back to ListObjectsV2");
    return reconcileWithS3Listing(hashSet);
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
      console.warn("[GC] Empty inventory file, falling back to ListObjectsV2");
      return reconcileWithS3Listing(hashSet);
    }

    const orphanedKeys: string[] = [];
    const lines = body.split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;
      // S3 Inventory CSV format: bucket, key, ...
      const parts = line.split(",");
      const key = parts[1]?.replace(/"/g, "").trim();
      if (!key || key.startsWith("temp-")) continue;

      if (!hashSet.has(key)) {
        orphanedKeys.push(key);
      }
    }

    // Batch delete
    const DELETE_BATCH = 1000;
    for (let i = 0; i < orphanedKeys.length; i += DELETE_BATCH) {
      const batch = orphanedKeys.slice(i, i + DELETE_BATCH);
      await s3.send(new DeleteObjectsCommand({
        Bucket: BUCKET_NAME,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }));
      deletedCount += batch.length;
    }

    console.log(`[GC] Inventory: processed ${lines.length} entries, deleted ${deletedCount} orphans`);
  } catch (err) {
    console.error("[GC] Failed to read inventory, falling back to ListObjectsV2:", err);
    return reconcileWithS3Listing(hashSet);
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
