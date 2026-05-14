/**
 * Phase 2 — Streaming multipart upload (no more Base64).
 *
 * Protocol (multipart/form-data):
 *   meta     — JSON string: { path, blockSize, newSize, contentSha256, ops }
 *   literals — raw binary blob: concatenated bytes of all literal runs
 *
 * Op types:
 *   { type: "copy",    blockIndex: number }
 *   { type: "literal", literalOffset: number, literalLength: number }
 *
 * Phase 1 benefit: copy ops just point to the same strongHash in the block-store.
 * Storage cost for a 1-byte edit in a 4 GB file is O(1) not O(N).
 */

import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";
import { validateApiKey } from "@/lib/api-key-auth";
import { db } from "../../../../../server/db";
import { files, fileVersions, blocks, syncJobs } from "../../../../../shared/schema";
import { adler32, sha256Hex } from "../../../../../shared/hash";
import { and, eq, max } from "drizzle-orm";
import { z } from "zod";

const opSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("copy"),    blockIndex: z.number().int().min(0) }),
  z.object({ type: z.literal("literal"), literalOffset: z.number().int().min(0), literalLength: z.number().int().min(1) }),
]);

const metaSchema = z.object({
  path:          z.string().min(1).max(1024).refine(p => !p.startsWith('/') && !p.includes('../') && !p.includes('./'), "Invalid logical path traversal"),
  blockSize:     z.number().int().min(256).max(65536),
  newSize:       z.number().int().min(0),
  contentSha256: z.string().length(64),
  ops:           z.array(opSchema),
});

import { PassThrough } from "node:stream";
import crypto from "node:crypto";
import { Upload } from "@aws-sdk/lib-storage";
import { S3Client, CopyObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

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
        if (contentLength > 500 * 1024 * 1024) { // 500MB size limit
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

        const prevBlockMap = new Map<number, string>();

        if (existingFile?.currentVersionId) {
          const prevBlocks = await db
            .select({ blockIndex: blocks.blockIndex, strongHash: blocks.strongHash })
            .from(blocks)
            .where(eq(blocks.versionId, existingFile.currentVersionId));
          for (const b of prevBlocks) prevBlockMap.set(b.blockIndex, b.strongHash);
        }

        for (const op of meta.ops) {
          if (op.type === "copy" && !prevBlockMap.has(op.blockIndex)) {
            return json({ error: `Copy op references unknown block ${op.blockIndex}` }, 400);
          }
        }

        type Resolved =
          | { kind: "copy";    strongHash: string }
          | { kind: "literal"; strongHash: string; weakHash: number };

        const resolved: Resolved[] = [];
        let bytesTransferred = 0;

        if (literalsEntry instanceof Blob) {
          const stream = literalsEntry.stream();
          const reader = stream.getReader();
          let currentChunk = new Uint8Array(0);

          for (const op of meta.ops) {
            if (op.type === "copy") {
              resolved.push({ kind: "copy", strongHash: prevBlockMap.get(op.blockIndex)! });
            } else {
              const length = op.literalLength;
              const passThrough = new PassThrough();
              const tempKey = `temp-${crypto.randomUUID()}`;
              
              const upload = new Upload({
                client: s3,
                params: { Bucket: BUCKET_NAME, Key: tempKey, Body: passThrough }
              });
              const uploadPromise = upload.done();
              
              const hashObj = crypto.createHash("sha256");
              let weakA = 1, weakB = 0;
              const MOD_ADLER = 65521;
              
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
                
                for (let i = 0; i < slice.length; i++) {
                  weakA = (weakA + slice[i]) % MOD_ADLER;
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
                  Bucket: BUCKET_NAME,
                  CopySource: `${BUCKET_NAME}/${tempKey}`,
                  Key: strongHash
                }));
              } catch (e) {
                // If it already exists or copy fails, we still delete temp
              }
              await s3.send(new DeleteObjectCommand({
                Bucket: BUCKET_NAME,
                Key: tempKey
              }));
              
              resolved.push({ kind: "literal", strongHash, weakHash });
            }
          }
        } else {
          for (const op of meta.ops) {
            if (op.type === "copy") {
              resolved.push({ kind: "copy", strongHash: prevBlockMap.get(op.blockIndex)! });
            }
          }
        }

        const bytesSaved = Math.max(0, meta.newSize - bytesTransferred);

        // ── persist to DB in a single transaction ────────────────────────────
        let returnVal = { versionNo: 0, bytesSaved };

        try {
          await db.transaction(async (tx) => {
            let fileId: string;
            if (existingFile) {
              fileId = existingFile.id;
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

            const [version] = await tx.insert(fileVersions).values({
              fileId,
              versionNo:    nextVer,
              size:         meta.newSize,
              totalBlocks:  resolved.length,
              blockSize:    meta.blockSize,
              contentSha256: meta.contentSha256,
            }).returning();

            const chunkSize = 500;
            for (let i = 0; i < resolved.length; i += chunkSize) {
              const chunk = resolved.slice(i, i + chunkSize);
              const values = chunk.map((r, idx) => ({
                versionId: version.id,
                blockIndex: i + idx,
                weakHash: r.kind === "literal" ? r.weakHash : 0,
                strongHash: r.strongHash,
              }));
              if (values.length > 0) {
                await tx.insert(blocks).values(values);
              }
            }

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
        } catch (err: any) {
          if (err.code === "23505" || err.message?.includes("unique constraint")) {
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


