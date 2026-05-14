/**
 * Multipart upload: meta JSON + raw literal bytes.
 * Concurrent uploads for the same logical file are serialized with pg_advisory_xact_lock
 * so each client gets the next version number instead of 409 unique violations.
 *
 * Chunk metadata is stored in a single packed `chunk_manifest` bytea per version
 * (no per-chunk table rows).
 */

import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";
import { validateApiKey } from "@/lib/api-key-auth";
import { db } from "../../../../../server/db";
import { files, fileVersions, syncJobs } from "../../../../../shared/schema";
import { encodeChunkManifestV1 } from "../../../../../shared/chunk-manifest";
import { loadVersionChunks } from "../../../../../server/version-chunks";
import { max, eq, and, sql } from "drizzle-orm";
import { z } from "zod";

import { PassThrough } from "node:stream";
import crypto from "node:crypto";
import { Upload } from "@aws-sdk/lib-storage";
import { S3Client, CopyObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

const opSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("copy"), blockIndex: z.number().int().min(0) }),
  z.object({ type: z.literal("literal"), literalOffset: z.number().int().min(0), literalLength: z.number().int().min(1) }),
]);

const metaSchema = z.object({
  path:          z.string().min(1).max(1024).refine(p => !p.startsWith('/') && !p.includes('../') && !p.includes('./'), "Invalid logical path traversal"),
  chunking:      z.enum(["cdc", "fixed"]).optional().default("cdc"),
  blockSize:     z.number().int().min(256).max(1048576),
  newSize:       z.number().int().min(0),
  contentSha256: z.string().length(64),
  ops:           z.array(opSchema),
});

const s3 = new S3Client({
  region: process.env.S3_REGION || "auto",
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID || "dev",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "dev",
  },
});
const BUCKET_NAME = process.env.S3_BUCKET_NAME || "deltasync-blocks";

import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

async function checkRateLimit(userId: string) {
  const key = `rate_limit:${userId}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 60);
  }
  return count <= 60;
}

/** Yield so other HTTP handlers can run during long Adler-32 loops. */
async function yieldIfNeeded(byteIndex: number): Promise<void> {
  if (byteIndex > 0 && byteIndex % 65536 === 0) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

export const Route = createFileRoute("/api/public/sync/upload")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const userId = await validateApiKey(request.headers.get("Authorization"));
        if (!userId) return json({ error: "Unauthorized" }, 401);

        if (!(await checkRateLimit(userId))) {
          return json({ error: "Rate limit exceeded" }, 429);
        }

        const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
        if (contentLength > 500 * 1024 * 1024) {
          return json({ error: "Payload too large" }, 413);
        }

        let formData: FormData;
        try { formData = await request.formData(); }
        catch { return json({ error: "Expected multipart/form-data" }, 400); }

        const metaStr = formData.get("meta");
        if (typeof metaStr !== "string") return json({ error: "Missing 'meta' field" }, 400);

        let meta: z.infer<typeof metaSchema>;
        try { meta = metaSchema.parse(JSON.parse(metaStr)); }
        catch (e) { return json({ error: "Invalid meta: " + String(e) }, 400); }

        const literalsEntry = formData.get("literals");
        if (literalsEntry && !(literalsEntry instanceof Blob)) {
          return json({ error: "Invalid literals" }, 400);
        }

        const [existingFile] = await db.select().from(files)
          .where(and(eq(files.userId, userId), eq(files.path, meta.path)));

        const snapshotCurrentVersionId = existingFile?.currentVersionId ?? null;

        let prevChunks = await (async () => {
          if (!existingFile?.currentVersionId) return [];
          const [ver] = await db.select().from(fileVersions)
            .where(eq(fileVersions.id, existingFile.currentVersionId));
          if (!ver) return [];
          return loadVersionChunks(db, existingFile.currentVersionId, ver);
        })();

        const prevByIndex = new Map(prevChunks.map((c) => [c.blockIndex, c]));

        for (const op of meta.ops) {
          if (op.type === "copy" && !prevByIndex.has(op.blockIndex)) {
            return json({ error: `Copy op references unknown block ${op.blockIndex}` }, 400);
          }
        }

        type ManifestRow = { offset: number; length: number; weakHash: number; strongHashHex: string };
        const manifestRows: ManifestRow[] = [];
        let bytesTransferred = 0;
        let runningOffset = 0;

        if (literalsEntry instanceof Blob) {
          const stream = literalsEntry.stream();
          const reader = stream.getReader();
          let currentChunk = new Uint8Array(0);

          for (const op of meta.ops) {
            if (op.type === "copy") {
              const pc = prevByIndex.get(op.blockIndex)!;
              manifestRows.push({
                offset:        runningOffset,
                length:        pc.length,
                weakHash:      pc.weakHash,
                strongHashHex: pc.strongHashHex,
              });
              runningOffset += pc.length;
            } else {
              const length = op.literalLength;
              const passThrough = new PassThrough();
              const tempKey = `temp-${crypto.randomUUID()}`;

              const upload = new Upload({
                client: s3,
                params: { Bucket: BUCKET_NAME, Key: tempKey, Body: passThrough },
              });
              const uploadPromise = upload.done();

              const hashObj = crypto.createHash("sha256");
              let weakA = 1, weakB = 0;
              const MOD_ADLER = 65521;

              let remaining = length;
              let adlerByteIdx = 0;
              while (remaining > 0) {
                if (currentChunk.length === 0) {
                  const { done, value } = await reader.read();
                  if (done) throw new Error("Unexpected end of stream");
                  currentChunk = value;
                }

                const take = Math.min(remaining, currentChunk.length);
                const slice = currentChunk.subarray(0, take);

                passThrough.write(slice);
                hashObj.update(slice);

                for (let i = 0; i < slice.length; i++) {
                  await yieldIfNeeded(adlerByteIdx++);
                  weakA = (weakA + slice[i]!) % MOD_ADLER;
                  weakB = (weakB + weakA) % MOD_ADLER;
                }

                remaining -= take;
                bytesTransferred += take;
                currentChunk = currentChunk.subarray(take);
              }
              passThrough.end();
              await uploadPromise;

              const strongHash = hashObj.digest("hex");
              const weakHash = ((weakB << 16) | weakA) >>> 0;

              try {
                await s3.send(new CopyObjectCommand({
                  Bucket:     BUCKET_NAME,
                  CopySource: `${BUCKET_NAME}/${tempKey}`,
                  Key:        strongHash,
                }));
              } catch { /* object may already exist */ }
              await s3.send(new DeleteObjectCommand({
                Bucket: BUCKET_NAME,
                Key:    tempKey,
              }));

              manifestRows.push({
                offset:        runningOffset,
                length,
                weakHash,
                strongHashHex: strongHash,
              });
              runningOffset += length;
            }
          }
        } else {
          for (const op of meta.ops) {
            if (op.type === "copy") {
              const pc = prevByIndex.get(op.blockIndex)!;
              manifestRows.push({
                offset:        runningOffset,
                length:        pc.length,
                weakHash:      pc.weakHash,
                strongHashHex: pc.strongHashHex,
              });
              runningOffset += pc.length;
            }
          }
        }

        if (runningOffset !== meta.newSize) {
          return json({ error: `Reconstructed size ${runningOffset} does not match newSize ${meta.newSize}` }, 400);
        }

        const bytesSaved = Math.max(0, meta.newSize - bytesTransferred);

        let returnVal = { versionNo: 0, bytesSaved };

        try {
          await db.transaction(async (tx) => {
            const lockKey = `${userId}:${meta.path}`;
            await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}::text))`);

            const [ef] = await tx.select().from(files)
              .where(and(eq(files.userId, userId), eq(files.path, meta.path)));

            if ((ef?.currentVersionId ?? null) !== snapshotCurrentVersionId) {
              throw Object.assign(new Error("stale_remote"), { code: "STALE" });
            }

            let fileId: string;
            if (ef) {
              fileId = ef.id;
            } else {
              const [f] = await tx.insert(files)
                .values({ userId, path: meta.path, totalSize: meta.newSize })
                .returning();
              fileId = f.id;
            }

            const [{ maxVer }] = await tx
              .select({ maxVer: max(fileVersions.versionNo) })
              .from(fileVersions)
              .where(eq(fileVersions.fileId, fileId));
            const nextVer = (maxVer ?? 0) + 1;

            const packed = encodeChunkManifestV1(manifestRows);

            const [version] = await tx.insert(fileVersions).values({
              fileId,
              versionNo:     nextVer,
              size:          meta.newSize,
              totalBlocks:   manifestRows.length,
              blockSize:     meta.blockSize,
              chunkManifest: packed,
              chunkingMode:  meta.chunking,
              contentSha256: meta.contentSha256,
            }).returning();

            await tx.update(files)
              .set({ currentVersionId: version.id, totalSize: meta.newSize })
              .where(eq(files.id, fileId));

            await tx.insert(syncJobs).values({
              userId, fileId, direction: "push",
              bytesTransferred, bytesSaved, status: "done",
              finishedAt: new Date(),
            });

            returnVal = { versionNo: nextVer, bytesSaved };
          });
        } catch (err: unknown) {
          if (err && typeof err === "object" && (err as { code?: string }).code === "STALE") {
            return json({ error: "Remote file changed during upload. Pull latest signatures and retry." }, 409);
          }
          if ((err as { code?: string })?.code === "23505" || String((err as Error).message).includes("unique constraint")) {
            return json({ error: "Concurrent sync conflict. Please pull and retry." }, 409);
          }
          throw err;
        }

        return json(returnVal);
      },
    },
  },
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
