/**
 * Returns chunk signatures for the current file version.
 * Prefers packed `chunk_manifest`; falls back to legacy `blocks` rows.
 */

import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";
import { validateApiKey } from "@/lib/api-key-auth";
import { db } from "../../../../../server/db";
import { files, fileVersions } from "../../../../../shared/schema";
import { loadVersionChunks } from "../../../../../server/version-chunks";
import { and, eq } from "drizzle-orm";

export const Route = createFileRoute("/api/public/sync/signatures")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const userId = await validateApiKey(request.headers.get("Authorization"));
        if (!userId) return json({ error: "Unauthorized" }, 401);

        const body = await request.json() as { path?: string };
        if (!body?.path) return json({ error: "path required" }, 400);

        const [file] = await db.select().from(files)
          .where(and(eq(files.userId, userId), eq(files.path, body.path)));

        if (!file || !file.currentVersionId) {
          return json(null);
        }

        const [version] = await db.select().from(fileVersions)
          .where(eq(fileVersions.id, file.currentVersionId));
        if (!version) return json(null);

        const chunks = await loadVersionChunks(db, version.id, version);

        const signatures = chunks.map((s) => ({
          blockIndex: s.blockIndex,
          weakHash:   Number(s.weakHash),
          strongHash: s.strongHashHex,
          offset:     s.offset,
          length:     s.length,
        }));

        return json({
          fileId:     file.id,
          versionNo:  version.versionNo,
          blockSize:  version.blockSize,
          chunking:   version.chunkingMode,
          signatures,
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
