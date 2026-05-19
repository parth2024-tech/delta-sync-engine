/**
 * File Info endpoint — Lightweight metadata query without streaming binary data.
 * Returns contentSha256, versionNo, size, and verificationStatus.
 */

import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";
import { validateApiKey } from "@/lib/api-key-auth";
import { db } from "../../../../../server/db";
import { files, fileVersions } from "../../../../../shared/schema";
import { and, eq, desc } from "drizzle-orm";

export const Route = createFileRoute("/api/public/sync/info")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const userId = await validateApiKey(request.headers.get("Authorization"));
        if (!userId) return json({ error: "Unauthorized" }, 401);

        const body = await request.json() as { path?: string };
        if (!body?.path) return json({ error: "path required" }, 400);

        const [file] = await db.select().from(files)
          .where(and(eq(files.userId, userId), eq(files.path, body.path)));
        if (!file) return json(null);

        const [version] = await db.select().from(fileVersions)
          .where(eq(fileVersions.fileId, file.id))
          .orderBy(desc(fileVersions.versionNo))
          .limit(1);

        if (!version) return json(null);

        return json({
          fileId: file.id,
          path: file.path,
          versionNo: version.versionNo,
          size: version.size,
          contentSha256: version.contentSha256,
          verificationStatus: version.verificationStatus,
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
