import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { z } from "zod";
import { db } from "../../server/db";
import { files, fileVersions, syncJobs, blocks } from "../../shared/schema";
import { eq, desc, sql, and, gte, count } from "drizzle-orm";
import { verifySessionToken } from "../../server/auth";

async function requireAuth() {
  const token = getCookie("ds_session");
  if (!token) throw new Error("Unauthorized");
  const userId = await verifySessionToken(token);
  if (!userId) throw new Error("Unauthorized");
  return userId;
}

export const getDashboardStats = createServerFn({ method: "GET" }).handler(async () => {
  const userId = await requireAuth();

  const [totals] = await db.select({
    totalFiles:           count(files.id),
    totalBytesTransferred: sql<number>`coalesce(sum(${syncJobs.bytesTransferred}), 0)`,
    totalBytesSaved:       sql<number>`coalesce(sum(${syncJobs.bytesSaved}), 0)`,
  }).from(files)
    .leftJoin(syncJobs, eq(syncJobs.fileId, files.id))
    .where(eq(files.userId, userId));

  const [{ active }] = await db.select({ active: count() }).from(syncJobs)
    .where(and(eq(syncJobs.userId, userId), gte(syncJobs.startedAt, new Date(Date.now() - 86400000))));

  const thirtyAgo = new Date(Date.now() - 30 * 86400000);
  const dailySeries = await db.select({
    day:         sql<string>`date_trunc('day', ${syncJobs.startedAt})::text`,
    transferred: sql<number>`coalesce(sum(${syncJobs.bytesTransferred}), 0)`,
    saved:       sql<number>`coalesce(sum(${syncJobs.bytesSaved}), 0)`,
  }).from(syncJobs)
    .where(and(eq(syncJobs.userId, userId), gte(syncJobs.startedAt, thirtyAgo)))
    .groupBy(sql`date_trunc('day', ${syncJobs.startedAt})`)
    .orderBy(sql`date_trunc('day', ${syncJobs.startedAt})`);

  const recentJobs = await db.select({
    id: syncJobs.id, direction: syncJobs.direction,
    bytesTransferred: syncJobs.bytesTransferred, bytesSaved: syncJobs.bytesSaved,
    status: syncJobs.status, startedAt: syncJobs.startedAt, filePath: files.path,
  }).from(syncJobs)
    .leftJoin(files, eq(syncJobs.fileId, files.id))
    .where(eq(syncJobs.userId, userId))
    .orderBy(desc(syncJobs.startedAt))
    .limit(10);

  const saved       = Number(totals?.totalBytesSaved ?? 0);
  const transferred = Number(totals?.totalBytesTransferred ?? 0);
  const ratio       = transferred + saved > 0 ? Math.round((saved / (transferred + saved)) * 100) : 0;

  return { totalFiles: totals?.totalFiles ?? 0, totalBytesSaved: saved, transferRatio: ratio, activeIn24h: active, dailySeries, recentJobs };
});

export const listFiles = createServerFn({ method: "GET" })
  .inputValidator(z.object({ search: z.string().optional(), page: z.number().default(1), pageSize: z.number().default(20) }))
  .handler(async ({ data }) => {
    const userId = await requireAuth();
    return db.select({
      id: files.id, path: files.path, totalSize: files.totalSize,
      createdAt: files.createdAt, currentVersionId: files.currentVersionId,
    }).from(files).where(eq(files.userId, userId))
      .orderBy(desc(files.createdAt))
      .limit(data.pageSize).offset((data.page - 1) * data.pageSize);
  });

export const getFileDetail = createServerFn({ method: "GET" })
  .inputValidator(z.object({ fileId: z.string() }))
  .handler(async ({ data }) => {
    const userId = await requireAuth();
    const [file] = await db.select().from(files)
      .where(and(eq(files.id, data.fileId), eq(files.userId, userId)));
    if (!file) throw new Error("Not found");

    const versions = await db.select().from(fileVersions)
      .where(eq(fileVersions.fileId, file.id)).orderBy(desc(fileVersions.versionNo));

    const versionBlocks = await Promise.all(versions.map(async (v) => {
      const blks = await db.select({
        blockIndex: blocks.blockIndex, weakHash: blocks.weakHash, strongHash: blocks.strongHash, length: blocks.length,
      }).from(blocks).where(eq(blocks.versionId, v.id)).orderBy(blocks.blockIndex);
      return { version: v, blocks: blks };
    }));

    return { file, versionBlocks };
  });

export const listSyncJobs = createServerFn({ method: "GET" })
  .inputValidator(z.object({ page: z.number().default(1), pageSize: z.number().default(20), status: z.string().optional() }))
  .handler(async ({ data }) => {
    const userId = await requireAuth();
    return db.select({
      id: syncJobs.id, direction: syncJobs.direction,
      bytesTransferred: syncJobs.bytesTransferred, bytesSaved: syncJobs.bytesSaved,
      status: syncJobs.status, startedAt: syncJobs.startedAt,
      finishedAt: syncJobs.finishedAt, error: syncJobs.error, filePath: files.path,
    }).from(syncJobs)
      .leftJoin(files, eq(syncJobs.fileId, files.id))
      .where(eq(syncJobs.userId, userId))
      .orderBy(desc(syncJobs.startedAt))
      .limit(data.pageSize).offset((data.page - 1) * data.pageSize);
  });

export const downloadVersion = createServerFn({ method: "POST" })
  .inputValidator(z.object({ fileId: z.string(), versionId: z.string() }))
  .handler(async ({ data }) => {
    const userId = await requireAuth();
    const [file] = await db.select().from(files)
      .where(and(eq(files.id, data.fileId), eq(files.userId, userId)));
    if (!file) throw new Error("Not found");

    const blks = await db.select({ data: blocks.data, blockIndex: blocks.blockIndex })
      .from(blocks).where(eq(blocks.versionId, data.versionId))
      .orderBy(blocks.blockIndex);

    const combined = blks.map((b) => b.data).join("");
    return { data: combined, filename: file.path.split("/").pop() ?? "download" };
  });
