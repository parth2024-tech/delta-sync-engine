/**
 * Phase 3 — O(1) memory streaming download pipeline.
 *
 * Instead of loading all block data into RAM and base64-decoding it,
 * we create a ReadableStream and pipe each block from the block-store
 * directly to the HTTP response.  Memory footprint ≈ one stream buffer
 * (typically 64 KB) regardless of file size.
 */

import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";
import { validateApiKey } from "@/lib/api-key-auth";
import { db } from "../../../../../server/db";
import { files, fileVersions, blocks } from "../../../../../shared/schema";
import { fetchBlock } from "../../../../../server/block-store";
import { and, eq, desc } from "drizzle-orm";

export const Route = createFileRoute("/api/public/sync/download")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const userId = await validateApiKey(request.headers.get("Authorization"));
        if (!userId) return json({ error: "Unauthorized" }, 401);

        const body = await request.json() as { path?: string; version?: number };
        if (!body?.path) return json({ error: "path required" }, 400);

        const [file] = await db.select().from(files)
          .where(and(eq(files.userId, userId), eq(files.path, body.path)));
        if (!file) return json({ error: "File not found" }, 404);

        let version;
        if (body.version != null) {
          [version] = await db.select().from(fileVersions)
            .where(and(eq(fileVersions.fileId, file.id), eq(fileVersions.versionNo, body.version)));
        } else {
          [version] = await db.select().from(fileVersions)
            .where(eq(fileVersions.fileId, file.id))
            .orderBy(desc(fileVersions.versionNo)).limit(1);
        }
        if (!version) return json({ error: "Version not found" }, 404);

        const blks = await db
          .select({ strongHash: blocks.strongHash })
          .from(blocks)
          .where(eq(blocks.versionId, version.id))
          .orderBy(blocks.blockIndex);

        const filename = file.path.split("/").pop() ?? "download";
        const fileSize = Number(version.size);

        // Phase 3: stream each block directly without buffering the whole file
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const blk of blks) {
              try {
                const data = await fetchBlock(blk.strongHash);
                controller.enqueue(data);
              } catch (err) {
                controller.error(
                  new Error(`Block ${blk.strongHash} not found in block-store: ${String(err)}`),
                );
                return;
              }
            }
            controller.close();
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type":        "application/octet-stream",
            "Content-Disposition": `attachment; filename="${filename}"`,
            ...(fileSize > 0 ? { "Content-Length": String(fileSize) } : {}),
          },
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
