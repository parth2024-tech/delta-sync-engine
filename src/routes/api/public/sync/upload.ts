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
import { storeBlock } from "../../../../../server/block-store";
import { and, eq, max } from "drizzle-orm";
import { z } from "zod";

const opSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("copy"),    blockIndex: z.number().int().min(0) }),
  z.object({ type: z.literal("literal"), literalOffset: z.number().int().min(0), literalLength: z.number().int().min(1) }),
]);

const metaSchema = z.object({
  path:          z.string().min(1).max(1024),
  blockSize:     z.number().int().min(256).max(65536),
  newSize:       z.number().int().min(0),
  contentSha256: z.string().length(64),
  ops:           z.array(opSchema),
});

export const Route = createFileRoute("/api/public/sync/upload")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const userId = await validateApiKey(request.headers.get("Authorization"));
        if (!userId) return json({ error: "Unauthorized" }, 401);

        // ── parse multipart ──────────────────────────────────────────────────
        let formData: FormData;
        try { formData = await request.formData(); }
        catch { return json({ error: "Expected multipart/form-data" }, 400); }

        const metaStr = formData.get("meta");
        if (typeof metaStr !== "string") return json({ error: "Missing 'meta' field" }, 400);

        let meta: z.infer<typeof metaSchema>;
        try { meta = metaSchema.parse(JSON.parse(metaStr)); }
        catch (e) { return json({ error: "Invalid meta: " + String(e) }, 400); }

        const literalsEntry = formData.get("literals");
        const literalBytes  = literalsEntry instanceof Blob
          ? new Uint8Array(await literalsEntry.arrayBuffer())
          : new Uint8Array(0);

        // ── validate literal byte ranges ─────────────────────────────────────
        for (const op of meta.ops) {
          if (op.type === "literal") {
            const end = op.literalOffset + op.literalLength;
            if (end > literalBytes.length) {
              return json({ error: `Literal op references bytes [${op.literalOffset},${end}) but literals blob is ${literalBytes.length} bytes` }, 400);
            }
          }
        }

        // ── load existing version's blocks for copy ops ──────────────────────
        const [existingFile] = await db.select().from(files)
          .where(and(eq(files.userId, userId), eq(files.path, meta.path)));

        const prevBlockMap = new Map<number, string>(); // blockIndex → strongHash

        if (existingFile?.currentVersionId) {
          const prevBlocks = await db
            .select({ blockIndex: blocks.blockIndex, strongHash: blocks.strongHash })
            .from(blocks)
            .where(eq(blocks.versionId, existingFile.currentVersionId));
          for (const b of prevBlocks) prevBlockMap.set(b.blockIndex, b.strongHash);
        }

        // ── validate copy ops reference known blocks ─────────────────────────
        for (const op of meta.ops) {
          if (op.type === "copy" && !prevBlockMap.has(op.blockIndex)) {
            return json({ error: `Copy op references unknown block ${op.blockIndex}` }, 400);
          }
        }

        // ── build per-op resolved data ────────────────────────────────────────
        type Resolved =
          | { kind: "copy";    strongHash: string }
          | { kind: "literal"; bytes: Uint8Array; strongHash: string; weakHash: number };

        const resolved: Resolved[] = [];
        let bytesTransferred = 0;

        for (const op of meta.ops) {
          if (op.type === "copy") {
            resolved.push({ kind: "copy", strongHash: prevBlockMap.get(op.blockIndex)! });
          } else {
            const chunk = literalBytes.subarray(op.literalOffset, op.literalOffset + op.literalLength);
            const strongHash = await sha256Hex(chunk);
            const weakHash   = adler32(chunk);
            bytesTransferred += chunk.length;
            resolved.push({ kind: "literal", bytes: chunk, strongHash, weakHash });
          }
        }

        const bytesSaved = Math.max(0, meta.newSize - bytesTransferred);

        // ── Phase 1: store literal blocks in content-addressed block store ───
        for (const r of resolved) {
          if (r.kind === "literal") {
            await storeBlock(r.strongHash, r.bytes);
          }
        }

        // ── persist to DB in a single transaction ────────────────────────────
        let returnVal = { versionNo: 0, bytesSaved };

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

          for (let i = 0; i < resolved.length; i++) {
            const r = resolved[i];
            await tx.insert(blocks).values({
              versionId:  version.id,
              blockIndex: i,
              weakHash:   r.kind === "literal" ? r.weakHash : 0,
              strongHash: r.strongHash,
            });
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

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const MOD_ADLER = 65521;
function adler32(data: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % MOD_ADLER;
    b = (b + a) % MOD_ADLER;
  }
  return ((b << 16) | a) >>> 0;
}
