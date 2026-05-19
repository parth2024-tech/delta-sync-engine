/**
 * Streaming download: block-store objects in manifest order.
 *
 * Checks:
 *   - Rate limiting (30 req/min per user)
 *   - Byte quota (500 MB/min per user)
 *   - Verification status: corrupted → 409, pending → 202 (unless ?force=true)
 */

import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";
import { validateApiKey } from "@/lib/api-key-auth";
import { db } from "../../../../../server/db";
import { files, fileVersions } from "../../../../../shared/schema";
import { loadVersionChunks } from "../../../../../server/version-chunks";
import { fetchBlock } from "../../../../../server/block-store";
import { checkDownloadRateLimit, checkByteQuota } from "../../../../../server/rate-limiter";
import { and, eq, desc } from "drizzle-orm";

export const Route = createFileRoute("/api/public/sync/download")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const userId = await validateApiKey(request.headers.get("Authorization"));
        if (!userId) return json({ error: "Unauthorized" }, 401);

        // Rate limit: 30 download requests per minute
        if (!checkDownloadRateLimit(userId)) {
          return json({ error: "Download rate limit exceeded" }, 429);
        }

        const body = await request.json() as { path?: string; version?: number; force?: boolean };
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

        // Block downloads of corrupted versions
        if (version.verificationStatus === "corrupted") {
          return json({
            error: "This version has been flagged as corrupted. Some chunks are missing from storage.",
            versionId: version.id,
            versionNo: version.versionNo,
          }, 409);
        }

        // Warn on pending verification (allow with ?force=true)
        if (version.verificationStatus === "pending" && !body.force) {
          return json({
            status: "pending_verification",
            message: "This version is still being verified. Retry shortly or pass force=true.",
            retryAfter: 5,
            versionId: version.id,
            versionNo: version.versionNo,
          }, 202);
        }

        // Byte quota: 500 MB/min per user
        const fileSize = Number(version.size);
        if (!checkByteQuota(userId, fileSize)) {
          return json({ error: "Download byte quota exceeded (500 MB/min). Try again later." }, 429);
        }

        const chunks = await loadVersionChunks(db, version.id, version);

        const filename = file.path.split("/").pop() ?? "download";

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const c of chunks) {
              try {
                const data = await fetchBlock(c.strongHashHex);
                controller.enqueue(data);
              } catch (err) {
                controller.error(
                  new Error(`Block ${c.strongHashHex} not found in block-store: ${String(err)}`),
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
