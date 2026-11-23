import { createFileRoute } from "@tanstack/react-router";
import { verifySessionToken } from "../../../../server/auth";
import { db } from "../../../../server/db";
import { files, fileVersions } from "../../../../shared/schema";
import { loadVersionChunks } from "../../../../server/version-chunks";
import { fetchBlock } from "../../../../server/block-store";
import { and, eq } from "drizzle-orm";

function getSessionToken(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)ds_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export const Route = createFileRoute("/api/files/download")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = getSessionToken(request);
        if (!token) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        const userId = await verifySessionToken(token);
        if (!userId) {
          return new Response(JSON.stringify({ error: "Invalid session" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        const url = new URL(request.url);
        const fileId = url.searchParams.get("fileId");
        const versionId = url.searchParams.get("versionId");

        if (!fileId || !versionId) {
          return new Response(JSON.stringify({ error: "fileId and versionId are required" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const [file] = await db
          .select()
          .from(files)
          .where(and(eq(files.id, fileId), eq(files.userId, userId)));

        if (!file) {
          return new Response(JSON.stringify({ error: "File not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        const [version] = await db
          .select()
          .from(fileVersions)
          .where(and(eq(fileVersions.id, versionId), eq(fileVersions.fileId, file.id)));

        if (!version) {
          return new Response(JSON.stringify({ error: "Version not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        const fileSize = Number(version.size);
        const filename = file.path.split("/").pop() ?? "download.bin";
        const chunks = await loadVersionChunks(db, version.id, version);

        const PREFETCH_WINDOW = 8;
        let currentIndex = 0;
        const inFlight = new Map<number, Promise<Uint8Array>>();

        const schedulePrefetches = () => {
          while (inFlight.size < PREFETCH_WINDOW && currentIndex + inFlight.size < chunks.length) {
            const targetIdx = currentIndex + inFlight.size;
            const targetChunk = chunks[targetIdx]!;
            if (!inFlight.has(targetIdx)) {
              inFlight.set(
                targetIdx,
                fetchBlock(targetChunk.strongHashHex).catch((err: unknown) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  throw new Error(`Block ${targetChunk.strongHashHex} fetch failed: ${msg}`);
                }),
              );
            }
          }
        };

        const stream = new ReadableStream<Uint8Array>({
          start() {
            schedulePrefetches();
          },
          async pull(controller) {
            if (currentIndex >= chunks.length) {
              controller.close();
              return;
            }

            if (controller.desiredSize !== null && controller.desiredSize <= 0) {
              return;
            }

            schedulePrefetches();

            const blockPromise = inFlight.get(currentIndex);
            if (!blockPromise) {
              controller.error(new Error(`Prefetch state error for chunk index ${currentIndex}`));
              return;
            }

            try {
              const data = await blockPromise;
              inFlight.delete(currentIndex);
              currentIndex++;
              controller.enqueue(data);
              schedulePrefetches();
            } catch (err) {
              controller.error(err instanceof Error ? err : new Error(String(err)));
            }
          },
          cancel() {
            inFlight.clear();
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
            ...(fileSize > 0 ? { "Content-Length": String(fileSize) } : {}),
            "Cache-Control": "private, no-cache, no-store, must-revalidate",
          },
        });
      },
    },
  },
});
