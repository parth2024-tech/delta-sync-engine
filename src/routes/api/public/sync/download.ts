import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";
import { validateApiKey } from "@/lib/api-key-auth";
import { db } from "../../../../../server/db";
import { files, fileVersions, blocks } from "../../../../../shared/schema";
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

        const blks = await db.select({ data: blocks.data })
          .from(blocks).where(eq(blocks.versionId, version.id))
          .orderBy(blocks.blockIndex);

        const combined = blks.map((b) => b.data).join("");
        const bytes    = Uint8Array.from(atob(combined), (c) => c.charCodeAt(0));
        const filename = file.path.split("/").pop() ?? "download";

        return new Response(bytes, {
          headers: {
            "Content-Type":        "application/octet-stream",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Content-Length":      String(bytes.length),
          },
        });
      },
    },
  },
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
