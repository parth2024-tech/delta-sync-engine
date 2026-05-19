/**
 * Version Pruner — Enforces retention policy on file versions.
 *
 * After every successful commit, this module is called asynchronously to
 * delete old versions beyond the MAX_VERSIONS_PER_FILE threshold.
 * The current version (pointed to by files.currentVersionId) is always preserved.
 *
 * Configurable via MAX_VERSIONS_PER_FILE environment variable (default: 10).
 */

import { db } from "./db";
import { files, fileVersions } from "../shared/schema";
import { eq, desc } from "drizzle-orm";

const MAX_VERSIONS = Math.max(
  1,
  parseInt(process.env.MAX_VERSIONS_PER_FILE || "10", 10) || 10,
);

/**
 * Prune old versions for a given file, keeping at most MAX_VERSIONS_PER_FILE.
 * Always preserves the version referenced by files.currentVersionId.
 *
 * @returns The number of versions deleted.
 */
export async function pruneFileVersions(fileId: string): Promise<number> {
  // Get the file's current version pointer
  const [file] = await db.select({ currentVersionId: files.currentVersionId })
    .from(files)
    .where(eq(files.id, fileId));

  if (!file) return 0;

  // Get all versions ordered by versionNo descending (newest first)
  const allVersions = await db.select({
    id: fileVersions.id,
    versionNo: fileVersions.versionNo,
  })
    .from(fileVersions)
    .where(eq(fileVersions.fileId, fileId))
    .orderBy(desc(fileVersions.versionNo));

  if (allVersions.length <= MAX_VERSIONS) return 0;

  // Determine which versions to keep:
  // 1. The N most recent by versionNo
  // 2. Always the currentVersionId (even if it's outside the top N)
  const keepIds = new Set(
    allVersions.slice(0, MAX_VERSIONS).map((v) => v.id),
  );

  if (file.currentVersionId) {
    keepIds.add(file.currentVersionId);
  }

  // Collect IDs to delete
  const toDeleteIds = allVersions
    .filter((v) => !keepIds.has(v.id))
    .map((v) => v.id);

  if (toDeleteIds.length === 0) return 0;

  // Delete each pruned version (cascade handles blocks table)
  for (const id of toDeleteIds) {
    await db.delete(fileVersions).where(eq(fileVersions.id, id));
  }

  console.log(
    `[Pruner] Pruned ${toDeleteIds.length} old version(s) for file ${fileId} (keeping ${keepIds.size}, max ${MAX_VERSIONS})`,
  );

  return toDeleteIds.length;
}
