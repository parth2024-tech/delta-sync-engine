import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";
import { validateApiKey } from "@/lib/api-key-auth";
import { db } from "../../../../../server/db";
import { files, fileVersions, blocks, syncJobs } from "../../../../../shared/schema";
import { and, eq, max } from "drizzle-orm";
import { z } from "zod";

const opSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("copy"),    blockIndex: z.number() }),
  z.object({ type: z.literal("literal"), bytesB64: z.string() }),
]);

const bodySchema = z.object({
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

        let body: z.infer<typeof bodySchema>;
        try { body = bodySchema.parse(await request.json()); }
        catch (e) { return json({ error: "Invalid body" }, 400); }

        const [existingFile] = await db.select().from(files)
          .where(and(eq(files.userId, userId), eq(files.path, body.path)));

        let existingBlocks: { blockIndex: number; data: string }[] = [];
        let prevVersionId: string | null = null;

        if (existingFile?.currentVersionId) {
          prevVersionId = existingFile.currentVersionId;
          existingBlocks = await db.select({ blockIndex: blocks.blockIndex, data: blocks.data })
            .from(blocks).where(eq(blocks.versionId, prevVersionId));
        }

        const existingBlockMap = new Map(existingBlocks.map((b) => [b.blockIndex, b.data]));

        let bytesTransferred = 0;
        const newBlockData: string[] = [];

        for (const op of body.ops) {
          if (op.type === "literal") {
            newBlockData.push(op.bytesB64);
            bytesTransferred += Math.ceil((op.bytesB64.length * 3) / 4);
          } else {
            const d = existingBlockMap.get(op.blockIndex);
            if (!d) return json({ error: `Block ${op.blockIndex} not found` }, 400);
            newBlockData.push(d);
          }
        }

        const bytesSaved = Math.max(0, body.newSize - bytesTransferred);

        await db.transaction(async (tx) => {
          let fileId: string;
          if (existingFile) {
            fileId = existingFile.id;
          } else {
            const [f] = await tx.insert(files).values({ userId, path: body.path, totalSize: body.newSize }).returning();
            fileId = f.id;
          }

          const [{ maxVer }] = await tx.select({ maxVer: max(fileVersions.versionNo) })
            .from(fileVersions).where(eq(fileVersions.fileId, fileId));
          const nextVer = (maxVer ?? 0) + 1;

          const [version] = await tx.insert(fileVersions).values({
            fileId, versionNo: nextVer, size: body.newSize,
            totalBlocks: newBlockData.length, blockSize: body.blockSize,
            contentSha256: body.contentSha256,
          }).returning();

          let offset = 0;
          for (let i = 0; i < body.ops.length; i++) {
            const op  = body.ops[i];
            const dat = newBlockData[i];
            const len = Math.ceil((dat.length * 3) / 4);
            const strong = await sha256B64(dat);
            const weak   = i;
            await tx.insert(blocks).values({
              versionId: version.id, blockIndex: i, offset, length: len,
              weakHash: weak, strongHash: strong, data: dat,
            });
            offset += len;
          }

          await tx.update(files)
            .set({ currentVersionId: version.id, totalSize: body.newSize })
            .where(eq(files.id, fileId));

          await tx.insert(syncJobs).values({
            userId, fileId, direction: "push",
            bytesTransferred, bytesSaved, status: "done",
            finishedAt: new Date(),
          });

          return { versionNo: nextVer, bytesSaved };
        });

        return json({ message: "uploaded", bytesSaved });
      },
    },
  },
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

async function sha256B64(b64: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(b64));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
