/**
 * Multipart upload: meta JSON + optional binary ops (`opsBin` / `opsFlatbuf`) + raw literal bytes.
 * 
 * Supports three operation encodings:
 *   - "json"    — JSON array (legacy, bandwidth-heavy)
 *   - "bin"     — DSO1 custom binary format
 *   - "flatbuf" — DSO2 FlatBuffer zero-copy format (recommended)
 *
 * Uses pg advisory lock, packed chunk_manifest, bounded S3 concurrency,
 * native bridge for hashing, and transactional outbox for event dispatch.
 */

import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";
import { validateApiKey } from "@/lib/api-key-auth";
import { db } from "../../../../../server/db";
import { files, fileVersions, syncJobs, outboxEvents } from "../../../../../shared/schema";
import { encodeChunkManifestV1 } from "../../../../../shared/chunk-manifest";
import { decodeOpsBinaryV1, opSchema } from "../../../../../shared/ops-binary";
import { decodeOpsUniversal } from "../../../../../shared/ops-flatbuf";
import type { UploadOp } from "../../../../../shared/ops-binary";
import { loadVersionChunks } from "../../../../../server/version-chunks";
import { createS3Limiter } from "../../../../../server/s3-limiter";
import { native } from "../../../../../server/native-bridge";
import { max, eq, and, sql } from "drizzle-orm";
import { z } from "zod";

import { PassThrough } from "node:stream";
import crypto from "node:crypto";
import { Upload } from "@aws-sdk/lib-storage";
import {
  S3Client,
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

const metaSchema = z.object({
  path:          z.string().min(1).max(1024).refine(p => !p.startsWith('/') && !p.includes('../') && !p.includes('./'), "Invalid logical path traversal"),
  chunking:      z.enum(["cdc", "fixed"]).optional().default("cdc"),
  blockSize:     z.number().int().min(256).max(1048576),
  newSize:       z.number().int().min(0),
  contentSha256: z.string().length(64),
  opsEncoding:   z.enum(["json", "bin", "flatbuf"]).optional().default("json"),
  /** Required when opsEncoding is `bin` (must match decoded `opsBin` length). */
  opCount:       z.number().int().min(0).optional(),
  ops:           z.array(opSchema).optional(),
}).superRefine((m, ctx) => {
  if (m.opsEncoding === "bin" || m.opsEncoding === "flatbuf") {
    if (m.opCount === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "opCount required when opsEncoding is bin/flatbuf" });
    }
  } else if (!m.ops || (m.ops.length === 0 && m.newSize > 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ops array required when opsEncoding is json" });
  }
});

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

const s3Limited = createS3Limiter(
  Math.max(1, Math.min(32, parseInt(process.env.S3_UPLOAD_CONCURRENCY || "6", 10) || 6)),
);

import { checkRateLimit } from "../../../../../server/rate-limiter";

async function blockExists(key: string): Promise<boolean> {
  try {
    await s3Limited(() =>
      s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key })),
    );
    return true;
  } catch (e: unknown) {
    const name = (e as { name?: string })?.name;
    const code = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    const s3code = (e as { Code?: string })?.Code;
    if (name === "NotFound" || code === 404 || s3code === "404" || s3code === "NoSuchKey") return false;
    throw e;
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

        let ops: UploadOp[];
        if (meta.opsEncoding === "bin" || meta.opsEncoding === "flatbuf") {
          const fieldName = meta.opsEncoding === "flatbuf" ? "opsFlatbuf" : "opsBin";
          const opsEntry = formData.get(fieldName) ?? formData.get("opsBin");
          if (!(opsEntry instanceof Blob)) {
            return json({ error: `Missing ${fieldName} field when opsEncoding is ${meta.opsEncoding}` }, 400);
          }
          let buf: Buffer;
          try { buf = Buffer.from(await opsEntry.arrayBuffer()); }
          catch { return json({ error: "Invalid ops buffer" }, 400); }
          try {
            const decoded = decodeOpsUniversal(buf);
            ops = decoded.ops;
          } catch (e) {
            return json({ error: "Invalid ops binary: " + String(e) }, 400);
          }
          if (ops.length !== meta.opCount) {
            return json({ error: `opCount ${meta.opCount} does not match decoded ops (${ops.length})` }, 400);
          }
        } else {
          ops = meta.ops!;
        }

        const literalsEntry = formData.get("literals");
        if (literalsEntry && !(literalsEntry instanceof Blob)) {
          return json({ error: "Invalid literals" }, 400);
        }

        const [existingFile] = await db.select().from(files)
          .where(and(eq(files.userId, userId), eq(files.path, meta.path)));

        const snapshotCurrentVersionId = existingFile?.currentVersionId ?? null;

        const prevChunks = await (async () => {
          if (!existingFile?.currentVersionId) return [];
          const [ver] = await db.select().from(fileVersions)
            .where(eq(fileVersions.id, existingFile.currentVersionId));
          if (!ver) return [];
          return loadVersionChunks(db, existingFile.currentVersionId, ver);
        })();

        const prevByIndex = new Map(prevChunks.map((c) => [c.blockIndex, c]));

        for (const op of ops) {
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

          for (const op of ops) {
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
              // Collect all bytes for this literal chunk for native hashing
              const chunkParts: Uint8Array[] = [];

              let remaining = length;
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
                chunkParts.push(new Uint8Array(slice));

                remaining -= take;
                bytesTransferred += take;
                currentChunk = currentChunk.subarray(take);
              }
              passThrough.end();
              await uploadPromise;

              const strongHash = hashObj.digest("hex");
              // Use native Adler-32 (no per-byte JS loop — offloaded to Rust/native)
              const fullChunk = Buffer.concat(chunkParts);
              const weakHash = native.adler32Native(fullChunk);

              const exists = await blockExists(strongHash);
              if (!exists) {
                await s3Limited(() =>
                  s3.send(new CopyObjectCommand({
                    Bucket:     BUCKET_NAME,
                    CopySource: `${BUCKET_NAME}/${tempKey}`,
                    Key:        strongHash,
                  })),
                );
              }
              await s3Limited(() =>
                s3.send(new DeleteObjectCommand({
                  Bucket: BUCKET_NAME,
                  Key:    tempKey,
                })),
              );

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
          for (const op of ops) {
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
            // SQLite transactions are naturally serialized for writes, so no advisory lock needed.

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

            // Transactional Outbox: emit event atomically with the version record
            await tx.insert(outboxEvents).values({
              eventType: "FILE_VERSION_CREATED",
              aggregateId: version.id,
              payload: JSON.stringify({
                userId, fileId, versionId: version.id, versionNo: nextVer,
                path: meta.path, size: meta.newSize, totalBlocks: manifestRows.length,
                contentSha256: meta.contentSha256,
              }),
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
