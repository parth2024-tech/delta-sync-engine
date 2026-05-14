import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { pool } from "./db";
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

const TEMP_REFS = "deltasync_gc_refs";

/**
 * Build referenced strong-hash set in a Postgres TEMP table (bounded Node memory).
 * One dedicated pool connection is held for the duration of the job.
 */
export async function runGarbageCollection() {
  console.log("Starting S3 Garbage Collection...");
  const client = await pool.connect();
  let deletedCount = 0;

  try {
    await client.query(`DROP TABLE IF EXISTS ${TEMP_REFS}`);
    await client.query(
      `CREATE TEMP TABLE ${TEMP_REFS} (h text PRIMARY KEY) ON COMMIT PRESERVE ROWS`,
    );

    const ins = await client.query(
      `INSERT INTO ${TEMP_REFS} (h) SELECT DISTINCT strong_hash FROM blocks ON CONFLICT DO NOTHING`,
    );
    console.log(`[GC] Indexed ${ins.rowCount ?? 0} legacy block hash rows (distinct).`);

    let lastId = "";
    let pages = 0;
    let versionsSeen = 0;
    for (;;) {
      const r = await client.query(
        lastId === ""
          ? `SELECT id, chunk_manifest FROM file_versions WHERE chunk_manifest IS NOT NULL ORDER BY id ASC LIMIT 80`
          : `SELECT id, chunk_manifest FROM file_versions WHERE chunk_manifest IS NOT NULL AND id > $1 ORDER BY id ASC LIMIT 80`,
        lastId === "" ? [] : [lastId],
      );
      if (r.rows.length === 0) break;
      pages++;
      for (const row of r.rows) {
        lastId = row.id as string;
        versionsSeen++;
        let chunks: ReturnType<typeof decodeChunkManifestV1>;
        try {
          chunks = decodeChunkManifestV1(Buffer.from(row.chunk_manifest));
        } catch {
          continue;
        }
        for (let i = 0; i < chunks.length; i += 4000) {
          const batch = chunks.slice(i, i + 4000).map((c) => c.strongHashHex);
          if (batch.length === 0) continue;
          await client.query(
            `INSERT INTO ${TEMP_REFS} (h) SELECT * FROM unnest($1::text[]) AS t(h) ON CONFLICT DO NOTHING`,
            [batch],
          );
        }
      }
      if (r.rows.length < 80) break;
    }
    console.log(`[GC] Processed ${versionsSeen} version manifest(s) in ${pages} page(s).`);

    let continuationToken: string | undefined;
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
        const CHUNK = 200;
        for (let i = 0; i < keys.length; i += CHUNK) {
          const chunk = keys.slice(i, i + CHUNK);
          const { rows } = await client.query<{ k: string }>(
            `SELECT x.k FROM unnest($1::text[]) AS x(k) WHERE NOT EXISTS (SELECT 1 FROM ${TEMP_REFS} r WHERE r.h = x.k)`,
            [chunk],
          );
          const deleteChunk = rows.map((row) => row.k);
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

  } catch (e) {
    console.error("[GC] Fatal:", e);
    throw e;
  } finally {
    try {
      await client.query(`DROP TABLE IF EXISTS ${TEMP_REFS}`);
    } catch { /* ignore */ }
    client.release();
  }

  console.log(`Garbage Collection finished. Deleted ${deletedCount} orphaned objects.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGarbageCollection().catch(console.error).finally(() => process.exit(0));
}
