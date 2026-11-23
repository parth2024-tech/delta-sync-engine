import crypto from "node:crypto";
import { db } from "./db";
import { files, fileVersions, syncJobs, outboxEvents } from "../shared/schema";
import { eq, sql, and } from "drizzle-orm";
import { outboxNotifier } from "./outbox-notifier";

export async function performRollbackToVersion(
  userId: string,
  data: { fileId: string; versionId: string },
) {
  const [file] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, data.fileId), eq(files.userId, userId)));
  if (!file) throw new Error("File not found");

  const [sourceVersion] = await db
    .select()
    .from(fileVersions)
    .where(and(eq(fileVersions.id, data.versionId), eq(fileVersions.fileId, file.id)));
  if (!sourceVersion) throw new Error("Source version not found");

  const [latest] = await db
    .select({ maxVer: sql<number>`max(${fileVersions.versionNo})` })
    .from(fileVersions)
    .where(eq(fileVersions.fileId, file.id));
  const nextVer = (latest?.maxVer ?? 0) + 1;

  const newVersionId = crypto.randomUUID();
  await db.insert(fileVersions).values({
    id: newVersionId,
    fileId: file.id,
    versionNo: nextVer,
    size: sourceVersion.size,
    totalBlocks: sourceVersion.totalBlocks,
    blockSize: sourceVersion.blockSize,
    chunkManifest: sourceVersion.chunkManifest,
    chunkingMode: sourceVersion.chunkingMode,
    contentSha256: sourceVersion.contentSha256,
    verificationStatus: "verified",
  });

  await db
    .update(files)
    .set({
      currentVersionId: newVersionId,
      totalSize: sourceVersion.size,
    })
    .where(eq(files.id, file.id));

  await db.insert(syncJobs).values({
    userId,
    fileId: file.id,
    direction: "push",
    bytesTransferred: 0,
    bytesSaved: sourceVersion.size,
    status: "done",
    startedAt: new Date(),
    finishedAt: new Date(),
  });

  await db.insert(outboxEvents).values({
    eventType: "FILE_VERSION_CREATED",
    aggregateId: newVersionId,
    payload: JSON.stringify({
      userId,
      fileId: file.id,
      versionId: newVersionId,
      versionNo: nextVer,
      path: file.path,
      size: sourceVersion.size,
      totalBlocks: sourceVersion.totalBlocks,
      contentSha256: sourceVersion.contentSha256,
      isRollback: true,
    }),
  });

  outboxNotifier.emitInserted();
  outboxNotifier.emitFileCommitted({
    fileId: file.id,
    path: file.path,
    versionNo: nextVer,
  });
  outboxNotifier.emitJobUpdate({
    jobId: `rollback-${newVersionId}`,
    status: "done",
    filePath: file.path,
  });

  return { newVersionNo: nextVer, newVersionId };
}
