import { asc, eq } from "drizzle-orm";
import { db } from "./db";
import { decodeChunkManifestV1, type ManifestChunk } from "../shared/chunk-manifest";
import * as schema from "../shared/schema";

type Db = typeof db;

export async function loadVersionChunks(
  dbClient: Db,
  versionId: string,
  versionRow: typeof schema.fileVersions.$inferSelect,
): Promise<ManifestChunk[]> {
  if (versionRow.chunkManifest) {
    return decodeChunkManifestV1(Buffer.from(versionRow.chunkManifest));
  }

  const sigs = await dbClient
    .select({
      blockIndex: schema.blocks.blockIndex,
      weakHash:   schema.blocks.weakHash,
      strongHash: schema.blocks.strongHash,
    })
    .from(schema.blocks)
    .where(eq(schema.blocks.versionId, versionId))
    .orderBy(asc(schema.blocks.blockIndex));

  const bs       = versionRow.blockSize;
  const fileSize = Number(versionRow.size);

  return sigs.map((s) => {
    const offset = s.blockIndex * bs;
    const length = Math.min(bs, fileSize - offset);
    return {
      blockIndex:     s.blockIndex,
      offset,
      length,
      weakHash:       Number(s.weakHash),
      strongHashHex:  s.strongHash,
    };
  });
}
