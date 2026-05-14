import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";
import { validateApiKey } from "@/lib/api-key-auth";
import { db } from "../../../../../server/db";
import { files, fileVersions, blocks } from "../../../../../shared/schema";
import { and, eq } from "drizzle-orm";

export const Route = createFileRoute("/api/public/sync/signatures")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const userId = await validateApiKey(request.headers.get("Authorization"));
        if (!userId) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });

        const body = await request.json() as { path?: string };
        if (!body?.path) return new Response(JSON.stringify({ error: "path required" }), { status: 400, headers: { "Content-Type": "application/json" } });

        const [file] = await db.select().from(files)
          .where(and(eq(files.userId, userId), eq(files.path, body.path)));

        if (!file || !file.currentVersionId) {
          return new Response(JSON.stringify(null), { headers: { "Content-Type": "application/json" } });
        }

        const [version] = await db.select().from(fileVersions)
          .where(eq(fileVersions.id, file.currentVersionId));
        if (!version) return new Response(JSON.stringify(null), { headers: { "Content-Type": "application/json" } });

        const sigs = await db.select({
          blockIndex: blocks.blockIndex, weakHash: blocks.weakHash,
          strongHash: blocks.strongHash, offset: blocks.offset, length: blocks.length,
        }).from(blocks).where(eq(blocks.versionId, version.id)).orderBy(blocks.blockIndex);

        return new Response(JSON.stringify({
          fileId: file.id, versionNo: version.versionNo,
          blockSize: version.blockSize, signatures: sigs,
        }), { headers: { "Content-Type": "application/json" } });
      },
    },
  },
});
