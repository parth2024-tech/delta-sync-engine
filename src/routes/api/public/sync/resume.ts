/**
 * Upload Resume — Check which chunks are still missing for an existing negotiation.
 *
 * Allows clients to resume interrupted uploads without re-hashing the local file:
 *   1. Client sends its existing negotiationId
 *   2. Server re-checks S3 for which chunks are still missing
 *   3. Server returns fresh pre-signed URLs for only the missing chunks
 */

import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";
import { validateApiKey } from "@/lib/api-key-auth";
import { createS3Limiter } from "../../../../../server/s3-limiter";
import { getNegotiation } from "../../../../../server/negotiation-store";
import { z } from "zod";
import { getStorageAdapter } from "../../../../../server/storage-adapter";
import { getS3Key } from "../../../../../shared/hash";

const storage = getStorageAdapter();

const resumeSchema = z.object({
  negotiationId: z.string().uuid(),
});

async function blockExists(key: string): Promise<boolean> {
  return storage.headObject(getS3Key(key));
}

export const Route = createFileRoute("/api/public/sync/resume")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const userId = await validateApiKey(request.headers.get("Authorization"));
        if (!userId) return json({ error: "Unauthorized" }, 401);

        let body: z.infer<typeof resumeSchema>;
        try {
          body = resumeSchema.parse(await request.json());
        } catch (e) {
          return json({ error: "Invalid request: " + String(e) }, 400);
        }

        // Look up the existing negotiation (non-consuming read)
        const negotiation = getNegotiation(body.negotiationId);
        if (!negotiation) {
          return json({ error: "Negotiation expired or invalid. Please re-negotiate." }, 410);
        }

        if (negotiation.userId !== userId) {
          return json({ error: "User mismatch" }, 403);
        }

        // Re-check which chunks are still missing in S3
        const uniqueHashes = [...new Set(negotiation.chunks.map((c) => c.strongHash))];
        const BATCH_SIZE = 50;
        const missingSet = new Set<string>();

        for (let i = 0; i < uniqueHashes.length; i += BATCH_SIZE) {
          const batch = uniqueHashes.slice(i, i + BATCH_SIZE);
          const results = await Promise.all(
            batch.map(async (hash) => ({
              hash,
              exists: await blockExists(hash),
            })),
          );
          for (const r of results) {
            if (!r.exists) missingSet.add(r.hash);
          }
        }

        // Generate fresh pre-signed URLs for still-missing chunks
        const PRESIGN_EXPIRY = 3600;
        const missingChunks: { strongHash: string; uploadUrl: string }[] = [];

        for (const hash of missingSet) {
          const uploadUrl = await storage.getUploadUrl(getS3Key(hash), PRESIGN_EXPIRY);
          missingChunks.push({ strongHash: hash, uploadUrl });
        }

        return json({
          negotiationId: body.negotiationId,
          missingChunks,
          totalChunks: uniqueHashes.length,
          alreadyUploaded: uniqueHashes.length - missingSet.size,
          presignExpiry: PRESIGN_EXPIRY,
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
