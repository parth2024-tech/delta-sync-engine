/**
 * Upload Commit — Phase 2 of the two-phase upload handshake.
 *
 * After the client has uploaded all missing chunks directly to S3 via
 * pre-signed URLs, it calls this endpoint to finalize the file version.
 *
 * This endpoint:
 *   1. Validates the negotiation token
 *   2. Atomically creates the file_versions record with chunk_manifest (status: pending)
 *   3. Emits a FILE_VERSION_CREATED event to the outbox table
 *   4. Background worker will verify all chunks exist in S3 asynchronously
 *   5. Responds instantly — no binary data flows through the server
 */

import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";
import { validateApiKey } from "@/lib/api-key-auth";
import { db } from "../../../../../server/db";
import { files, fileVersions, syncJobs, outboxEvents } from "../../../../../shared/schema";
import { encodeChunkManifestV1 } from "../../../../../shared/chunk-manifest";
import { max, eq, and } from "drizzle-orm";
import { z } from "zod";

import { getNegotiation, clearNegotiation } from "../../../../../server/negotiation-store";
import { pruneFileVersions } from "../../../../../server/version-pruner";
import { outboxNotifier } from "../../../../../server/outbox-notifier";

const commitSchema = z.object({
  negotiationId: z.string().uuid(),
});



export const Route = createFileRoute("/api/public/sync/commit")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const userId = await validateApiKey(request.headers.get("Authorization"));
        if (!userId) return json({ error: "Unauthorized" }, 401);

        let body: z.infer<typeof commitSchema>;
        try {
          body = commitSchema.parse(await request.json());
        } catch (e) {
          return json({ error: "Invalid request: " + String(e) }, 400);
        }

        // Retrieve the negotiation token (not consumed until commit succeeds — supports retries)
        const negotiation = getNegotiation(body.negotiationId);
        if (!negotiation) {
          return json({ error: "Negotiation expired or invalid" }, 410);
        }

        // Verify the authenticated user matches the negotiation
        if (negotiation.userId !== userId) {
          return json({ error: "User mismatch" }, 403);
        }

        // Build the chunk manifest (no spot-check; full verification happens in background worker)
        type ManifestRow = { offset: number; length: number; weakHash: number; strongHashHex: string };
        const manifestRows: ManifestRow[] = [];
        let runningOffset = 0;

        for (const chunk of negotiation.chunks) {
          manifestRows.push({
            offset: runningOffset,
            length: chunk.length,
            weakHash: chunk.weakHash ?? 0,
            strongHashHex: chunk.strongHash,
          });
          runningOffset += chunk.length;
        }

        if (runningOffset !== negotiation.newSize) {
          return json({
            error: `Reconstructed size ${runningOffset} does not match newSize ${negotiation.newSize}`,
          }, 400);
        }

        // Calculate bytes saved (chunks reused from previous version)
        const bytesTransferred = negotiation.chunks.reduce((sum, c) => sum + c.length, 0);
        const bytesSaved = Math.max(0, negotiation.newSize - bytesTransferred);

        let returnVal = { versionNo: 0, bytesSaved };

        try {
          await db.transaction(async (tx) => {
            // Advisory lock to prevent concurrent writes to the same file
            // SQLite transactions are serialized natively.

            // Optimistic concurrency check
            const [ef] = await tx.select().from(files)
              .where(and(eq(files.userId, userId), eq(files.path, negotiation.path)));

            if ((ef?.currentVersionId ?? null) !== negotiation.snapshotCurrentVersionId) {
              throw Object.assign(new Error("stale_remote"), { code: "STALE" });
            }

            let fileId: string;
            if (ef) {
              fileId = ef.id;
            } else {
              const [f] = await tx.insert(files)
                .values({ userId, path: negotiation.path, totalSize: negotiation.newSize })
                .returning();
              fileId = f.id;
            }

            const [{ maxVer }] = await tx
              .select({ maxVer: max(fileVersions.versionNo) })
              .from(fileVersions)
              .where(eq(fileVersions.fileId, fileId));
            const nextVer = (maxVer ?? 0) + 1;

            const packed = encodeChunkManifestV1(manifestRows);

            const [version] = await tx.insert(fileVersions).values({
              fileId,
              versionNo: nextVer,
              size: negotiation.newSize,
              totalBlocks: manifestRows.length,
              blockSize: negotiation.blockSize,
              chunkManifest: packed,
              chunkingMode: negotiation.chunking,
              contentSha256: negotiation.contentSha256,
              verificationStatus: "pending",
            }).returning();

            await tx.update(files)
              .set({ currentVersionId: version.id, totalSize: negotiation.newSize })
              .where(eq(files.id, fileId));

            await tx.insert(syncJobs).values({
              userId, fileId, direction: "push",
              bytesTransferred, bytesSaved, status: "done",
              finishedAt: new Date(),
            });

            // Step 3: Transactional Outbox — emit event atomically with the version record
            await tx.insert(outboxEvents).values({
              eventType: "FILE_VERSION_CREATED",
              aggregateId: version.id,
              payload: JSON.stringify({
                userId,
                fileId,
                versionId: version.id,
                versionNo: nextVer,
                path: negotiation.path,
                size: negotiation.newSize,
                totalBlocks: manifestRows.length,
                contentSha256: negotiation.contentSha256,
              }),
            });

            returnVal = { versionNo: nextVer, bytesSaved };
          });
        } catch (err: unknown) {
          if (err && typeof err === "object" && (err as { code?: string }).code === "STALE") {
            return json({ error: "Remote file changed during upload. Pull latest and retry." }, 409);
          }
          if ((err as { code?: string })?.code === "23505") {
            return json({ error: "Concurrent sync conflict. Please pull and retry." }, 409);
          }
          throw err;
        }

        // Consume the negotiation token after successful commit
        clearNegotiation(body.negotiationId);

        // Notify outbox dispatcher of new event
        outboxNotifier.emitInserted();

        // Fire version pruner asynchronously (non-blocking)
        const committedFileId = returnVal.versionNo > 0 ? (await db.select({ id: files.id }).from(files).where(and(eq(files.userId, userId), eq(files.path, negotiation.path))))[0]?.id : undefined;
        if (committedFileId) {
          void pruneFileVersions(committedFileId).catch((err) =>
            console.error("[Pruner] Error:", err),
          );
        }

        return json(returnVal);
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
