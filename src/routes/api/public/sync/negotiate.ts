/**
 * Pre-Signed Upload Negotiation — Phase 1 of the two-phase upload handshake.
 *
 * The client sends a lightweight manifest: "I have these chunk hashes."
 * The server responds with: "Upload these missing chunks directly to S3."
 *
 * Flow:
 *   1. Client computes CDC boundaries + SHA-256 hashes locally (WASM or native CLI)
 *   2. Client POSTs the manifest here → { path, chunks: [{strongHash, length}], ... }
 *   3. Server checks which chunks already exist in S3
 *   4. Server returns pre-signed PUT URLs only for the missing chunks
 *   5. Client uploads binary data directly to S3 (server network is bypassed)
 *   6. Client calls /api/public/sync/commit with the finalized manifest
 */

import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";
import { validateApiKey } from "@/lib/api-key-auth";
import { db } from "../../../../../server/db";
import { files, fileVersions } from "../../../../../shared/schema";
import { loadVersionChunks } from "../../../../../server/version-chunks";
import { createS3Limiter } from "../../../../../server/s3-limiter";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getS3Key } from "../../../../../shared/hash";

import {
  S3Client,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PutObjectCommand } from "@aws-sdk/client-s3";

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
  Math.max(1, Math.min(32, parseInt(process.env.S3_UPLOAD_CONCURRENCY || "12", 10) || 12)),
);

import { checkRateLimit } from "../../../../../server/rate-limiter";
import { setNegotiation } from "../../../../../server/negotiation-store";

const chunkInfoSchema = z.object({
  strongHash: z.string().length(64),
  length: z.number().int().min(1).max(4 * 1024 * 1024),
  weakHash: z.number().int().optional(),
});

const negotiateSchema = z.object({
  path: z.string().min(1).max(1024).refine(
    (p) => !p.startsWith("/") && !p.includes("../") && !p.includes("./"),
    "Invalid path",
  ),
  chunking: z.enum(["cdc", "fixed"]).optional().default("cdc"),
  blockSize: z.number().int().min(256).max(1048576),
  newSize: z.number().int().min(0),
  contentSha256: z.string().length(64),
  /** All chunks in the new file version, in order. */
  chunks: z.array(chunkInfoSchema).min(0).max(10_000_000),
});

async function blockExists(key: string): Promise<boolean> {
  try {
    await s3Limited(() =>
      s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: getS3Key(key) })),
    );
    return true;
  } catch (e: unknown) {
    const name = (e as { name?: string })?.name;
    const code = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (name === "NotFound" || code === 404) return false;
    throw e;
  }
}

export const Route = createFileRoute("/api/public/sync/negotiate")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const userId = await validateApiKey(request.headers.get("Authorization"));
        if (!userId) return json({ error: "Unauthorized" }, 401);

        if (!(await checkRateLimit(userId))) {
          return json({ error: "Rate limit exceeded" }, 429);
        }

        let body: z.infer<typeof negotiateSchema>;
        try {
          body = negotiateSchema.parse(await request.json());
        } catch (e) {
          return json({ error: "Invalid request: " + String(e) }, 400);
        }

        // Look up existing file to find reusable chunks from previous version
        const [existingFile] = await db.select().from(files)
          .where(and(eq(files.userId, userId), eq(files.path, body.path)));

        const snapshotCurrentVersionId = existingFile?.currentVersionId ?? null;

        // Load previous chunks to identify which chunks the client can "copy"
        const prevChunks = await (async () => {
          if (!existingFile?.currentVersionId) return [];
          const [ver] = await db.select().from(fileVersions)
            .where(eq(fileVersions.id, existingFile.currentVersionId));
          if (!ver) return [];
          return loadVersionChunks(db, existingFile.currentVersionId, ver);
        })();

        const prevHashSet = new Set(prevChunks.map((c) => c.strongHashHex));

        // Determine which chunks already exist (either in S3 or in the previous version)
        const missingChunks: { index: number; strongHash: string; uploadUrl: string }[] = [];
        const existingHashes: Set<string> = new Set();

        // Batch check S3 for chunks not in the previous version
        const toCheck: { index: number; strongHash: string }[] = [];
        for (let i = 0; i < body.chunks.length; i++) {
          const c = body.chunks[i]!;
          if (prevHashSet.has(c.strongHash) || existingHashes.has(c.strongHash)) {
            existingHashes.add(c.strongHash);
            continue;
          }
          if (existingHashes.has(c.strongHash)) continue;
          toCheck.push({ index: i, strongHash: c.strongHash });
        }

        // Deduplicate: only check each unique hash once
        const uniqueHashMap = new Map<string, number[]>();
        for (const item of toCheck) {
          const existing = uniqueHashMap.get(item.strongHash);
          if (existing) {
            existing.push(item.index);
          } else {
            uniqueHashMap.set(item.strongHash, [item.index]);
          }
        }

        // Check S3 existence in parallel batches
        const BATCH_SIZE = 50;
        const uniqueEntries = [...uniqueHashMap.entries()];
        for (let i = 0; i < uniqueEntries.length; i += BATCH_SIZE) {
          const batch = uniqueEntries.slice(i, i + BATCH_SIZE);
          const results = await Promise.all(
            batch.map(async ([hash]) => ({
              hash,
              exists: await blockExists(hash),
            })),
          );
          for (const r of results) {
            if (r.exists) {
              existingHashes.add(r.hash);
            }
          }
        }

        // Generate pre-signed URLs for truly missing chunks
        const PRESIGN_EXPIRY = 3600; // 1 hour
        for (const [hash, indices] of uniqueHashMap) {
          if (existingHashes.has(hash)) continue;

          const uploadUrl = await getSignedUrl(
            s3,
            new PutObjectCommand({
              Bucket: BUCKET_NAME,
              Key: getS3Key(hash), // content-addressed: upload directly to final key
              ContentType: "application/octet-stream",
            }),
            { expiresIn: PRESIGN_EXPIRY },
          );

          // Only need one upload URL per unique hash
          missingChunks.push({
            index: indices[0]!,
            strongHash: hash,
            uploadUrl,
          });
        }

        // Create a negotiation token (stored in memory) to validate the commit phase
        const negotiationId = crypto.randomUUID();
        setNegotiation(negotiationId, {
            userId,
            path: body.path,
            chunking: body.chunking,
            blockSize: body.blockSize,
            newSize: body.newSize,
            contentSha256: body.contentSha256,
            chunks: body.chunks,
            snapshotCurrentVersionId,
        });

        return json({
          negotiationId,
          missingChunks,
          totalChunks: body.chunks.length,
          existingChunks: body.chunks.length - missingChunks.length,
          presignExpiry: PRESIGN_EXPIRY,
        });
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
