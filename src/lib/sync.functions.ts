import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { z } from "zod";
import { db } from "../../server/db";
import { files, fileVersions, syncJobs, outboxEvents } from "../../shared/schema";
import { eq, desc, sql, and, gte, count, like } from "drizzle-orm";
import { verifySessionToken } from "../../server/auth";
import { fetchBlock } from "../../server/block-store";
import { loadVersionChunks } from "../../server/version-chunks";
import { outboxNotifier } from "../../server/outbox-notifier";

async function requireAuth() {
  const token = getCookie("ds_session");
  if (!token) throw new Error("Unauthorized");
  const userId = await verifySessionToken(token);
  if (!userId) throw new Error("Unauthorized");
  return userId;
}

export const getDashboardStats = createServerFn({ method: "GET" }).handler(async () => {
  const userId = await requireAuth();

  const [totals] = await db
    .select({
      totalFiles: count(files.id),
      totalBytesTransferred: sql<number>`coalesce(sum(${syncJobs.bytesTransferred}), 0)`,
      totalBytesSaved: sql<number>`coalesce(sum(${syncJobs.bytesSaved}), 0)`,
    })
    .from(files)
    .leftJoin(syncJobs, eq(syncJobs.fileId, files.id))
    .where(eq(files.userId, userId));

  const [{ active }] = await db
    .select({ active: count() })
    .from(syncJobs)
    .where(
      and(eq(syncJobs.userId, userId), gte(syncJobs.startedAt, new Date(Date.now() - 86400000))),
    );

  const thirtyAgo = new Date(Date.now() - 30 * 86400000);
  const dailySeries = await db
    .select({
      day: sql<string>`date(${syncJobs.startedAt} / 1000, 'unixepoch')`,
      transferred: sql<number>`coalesce(sum(${syncJobs.bytesTransferred}), 0)`,
      saved: sql<number>`coalesce(sum(${syncJobs.bytesSaved}), 0)`,
    })
    .from(syncJobs)
    .where(and(eq(syncJobs.userId, userId), gte(syncJobs.startedAt, thirtyAgo)))
    .groupBy(sql`date(${syncJobs.startedAt} / 1000, 'unixepoch')`)
    .orderBy(sql`date(${syncJobs.startedAt} / 1000, 'unixepoch')`);

  const dailyJobCounts = await db
    .select({
      day: sql<string>`date(${syncJobs.startedAt} / 1000, 'unixepoch')`,
      count: count(),
    })
    .from(syncJobs)
    .where(and(eq(syncJobs.userId, userId), gte(syncJobs.startedAt, thirtyAgo)))
    .groupBy(sql`date(${syncJobs.startedAt} / 1000, 'unixepoch')`)
    .orderBy(sql`date(${syncJobs.startedAt} / 1000, 'unixepoch')`);

  const recentJobs = await db
    .select({
      id: syncJobs.id,
      direction: syncJobs.direction,
      bytesTransferred: syncJobs.bytesTransferred,
      bytesSaved: syncJobs.bytesSaved,
      status: syncJobs.status,
      startedAt: syncJobs.startedAt,
      filePath: files.path,
    })
    .from(syncJobs)
    .leftJoin(files, eq(syncJobs.fileId, files.id))
    .where(eq(syncJobs.userId, userId))
    .orderBy(desc(syncJobs.startedAt))
    .limit(10);

  const saved = Number(totals?.totalBytesSaved ?? 0);
  const transferred = Number(totals?.totalBytesTransferred ?? 0);
  const ratio = transferred + saved > 0 ? Math.round((saved / (transferred + saved)) * 100) : 0;

  return {
    totalFiles: totals?.totalFiles ?? 0,
    totalBytesSaved: saved,
    totalBytesTransferred: transferred,
    transferRatio: ratio,
    activeIn24h: active,
    dailySeries,
    dailyJobCounts,
    recentJobs,
  };
});

export const listFiles = createServerFn({ method: "GET" })
  .inputValidator(
    z.object({
      search: z.string().optional(),
      page: z.number().default(1),
      pageSize: z.number().default(20),
    }),
  )
  .handler(async ({ data }) => {
    const userId = await requireAuth();
    const conditions = [eq(files.userId, userId)];
    if (data.search && data.search.trim()) {
      conditions.push(like(files.path, `%${data.search.trim()}%`));
    }

    const [totalRecord] = await db
      .select({ count: count() })
      .from(files)
      .where(and(...conditions));

    const rows = await db
      .select({
        id: files.id,
        path: files.path,
        totalSize: files.totalSize,
        createdAt: files.createdAt,
        currentVersionId: files.currentVersionId,
      })
      .from(files)
      .where(and(...conditions))
      .orderBy(desc(files.createdAt))
      .limit(data.pageSize)
      .offset((data.page - 1) * data.pageSize);

    return {
      files: rows,
      totalCount: totalRecord?.count ?? 0,
    };
  });

export const getFileDetail = createServerFn({ method: "GET" })
  .inputValidator(z.object({ fileId: z.string() }))
  .handler(async ({ data }) => {
    const userId = await requireAuth();
    const [file] = await db
      .select()
      .from(files)
      .where(and(eq(files.id, data.fileId), eq(files.userId, userId)));
    if (!file) throw new Error("Not found");

    const versions = await db
      .select()
      .from(fileVersions)
      .where(eq(fileVersions.fileId, file.id))
      .orderBy(desc(fileVersions.versionNo));

    const versionBlocks = await Promise.all(
      versions.map(async (v) => {
        const blks = await loadVersionChunks(db, v.id, v);
        const blocksWithMeta = blks.map((b) => ({
          blockIndex: b.blockIndex,
          weakHash: b.weakHash,
          strongHash: b.strongHashHex,
          offset: b.offset,
          length: b.length,
        }));
        return { version: v, blocks: blocksWithMeta };
      }),
    );

    return { file, versionBlocks };
  });

export const listSyncJobs = createServerFn({ method: "GET" })
  .inputValidator(
    z.object({
      page: z.number().default(1),
      pageSize: z.number().default(20),
      status: z.string().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const userId = await requireAuth();
    const conditions = [eq(syncJobs.userId, userId)];
    if (data.status && data.status !== "all") {
      conditions.push(eq(syncJobs.status, data.status as "pending" | "running" | "done" | "error"));
    }

    const [totalRecord] = await db
      .select({ count: count() })
      .from(syncJobs)
      .where(and(...conditions));

    const rows = await db
      .select({
        id: syncJobs.id,
        direction: syncJobs.direction,
        bytesTransferred: syncJobs.bytesTransferred,
        bytesSaved: syncJobs.bytesSaved,
        status: syncJobs.status,
        startedAt: syncJobs.startedAt,
        finishedAt: syncJobs.finishedAt,
        error: syncJobs.error,
        filePath: files.path,
      })
      .from(syncJobs)
      .leftJoin(files, eq(syncJobs.fileId, files.id))
      .where(and(...conditions))
      .orderBy(desc(syncJobs.startedAt))
      .limit(data.pageSize)
      .offset((data.page - 1) * data.pageSize);

    return {
      jobs: rows,
      totalCount: totalRecord?.count ?? 0,
    };
  });

export const rollbackToVersion = createServerFn({ method: "POST" })
  .inputValidator(z.object({ fileId: z.string(), versionId: z.string() }))
  .handler(async ({ data }) => {
    const userId = await requireAuth();
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
  });

// Deprecated: web downloads are now streamed natively via /api/files/download
export const downloadVersion = createServerFn({ method: "POST" })
  .inputValidator(z.object({ fileId: z.string(), versionId: z.string() }))
  .handler(async ({ data }) => {
    const userId = await requireAuth();
    const [file] = await db
      .select()
      .from(files)
      .where(and(eq(files.id, data.fileId), eq(files.userId, userId)));
    if (!file) throw new Error("Not found");

    const [version] = await db
      .select()
      .from(fileVersions)
      .where(eq(fileVersions.id, data.versionId));
    if (!version) throw new Error("Version not found");

    const blks = await loadVersionChunks(db, data.versionId, version);
    const parts = await Promise.all(blks.map((b) => fetchBlock(b.strongHashHex)));
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    const b64 = Buffer.from(out).toString("base64");
    const filename = file.path.split("/").pop() ?? "download";
    return { data: b64, filename };
  });
