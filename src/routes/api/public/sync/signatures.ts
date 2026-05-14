/**
 * Signatures endpoint — returns block signatures for the current version of a file.
 *
 * Phase 1: offset and length are no longer stored in the DB; they are derived:
 *   offset = blockIndex * blockSize
 *   length = min(blockSize, version.size - offset)
 */

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

        const sigs = await db
          .select({ blockIndex: blocks.blockIndex, weakHash: blocks.weakHash, strongHash: blocks.strongHash })
          .from(blocks)
          .where(eq(blocks.versionId, version.id))
          .orderBy(blocks.blockIndex);

        const bs       = version.blockSize;
        const fileSize = Number(version.size);

        // Derive offset + length from block metadata (Phase 1 — not stored in DB)
        const signatures = sigs.map((s) => {
          const offset = s.blockIndex * bs;
          const length = Math.min(bs, fileSize - offset);
          return {
            blockIndex: s.blockIndex,
            weakHash:   Number(s.weakHash),
            strongHash: s.strongHash,
            offset,
            length,
          };
        });

        return json({
          fileId:     file.id,
          versionNo:  version.versionNo,
          blockSize:  bs,
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
