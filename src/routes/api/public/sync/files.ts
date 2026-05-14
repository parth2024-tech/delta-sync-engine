import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";
import { validateApiKey } from "@/lib/api-key-auth";
import { db } from "../../../../../server/db";
import { files, fileVersions } from "../../../../../shared/schema";
import { eq, desc } from "drizzle-orm";

export const Route = createFileRoute("/api/public/sync/files")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const userId = await validateApiKey(request.headers.get("Authorization"));
        if (!userId) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });

        const rows = await db.select({
          id: files.id, path: files.path, totalSize: files.totalSize,
          currentVersionId: files.currentVersionId, createdAt: files.createdAt,
        }).from(files).where(eq(files.userId, userId)).orderBy(desc(files.createdAt));

        return new Response(JSON.stringify(rows), { headers: { "Content-Type": "application/json" } });
      },
    },
  },
});
