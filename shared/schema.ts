import {
  sqliteTable, text, integer, uniqueIndex, index, blob
} from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

export const users = sqliteTable("users", {
  id:           text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  email:        text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName:  text("display_name").notNull().default(""),
  createdAt:    integer("created_at", { mode: 'timestamp_ms' }).$defaultFn(() => new Date()).notNull(),
});

export const files = sqliteTable("files", {
  id:               text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId:           text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  path:             text("path").notNull(),
  currentVersionId: text("current_version_id"),
  totalSize:        integer("total_size", { mode: "number" }).notNull().default(0),
  createdAt:        integer("created_at", { mode: 'timestamp_ms' }).$defaultFn(() => new Date()).notNull(),
}, (t) => [
  uniqueIndex("files_user_path_unique").on(t.userId, t.path),
  index("files_user_id_idx").on(t.userId),
]);

export const fileVersions = sqliteTable("file_versions", {
  id:            text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  fileId:        text("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
  versionNo:     integer("version_no").notNull(),
  size:          integer("size", { mode: "number" }).notNull().default(0),
  totalBlocks:   integer("total_blocks").notNull().default(0),
  blockSize:     integer("block_size").notNull().default(4096),
  /** Packed chunk list (offset, length, weak, strong×32). Replaces per-row `blocks` for new versions. */
  chunkManifest: blob("chunk_manifest", { mode: 'buffer' }),
  /** `cdc` = content-defined chunks; `fixed` = legacy fixed-size blocks. */
  chunkingMode:  text("chunking_mode").notNull().default("fixed").$type<"cdc" | "fixed">(),
  contentSha256: text("content_sha256").notNull().default(""),
  createdAt:     integer("created_at", { mode: 'timestamp_ms' }).$defaultFn(() => new Date()).notNull(),
}, (t) => [
  uniqueIndex("file_versions_file_verno_unique").on(t.fileId, t.versionNo),
]);

export const blocks = sqliteTable("blocks", {
  id:         text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  versionId:  text("version_id").notNull().references(() => fileVersions.id, { onDelete: "cascade" }),
  blockIndex: integer("block_index").notNull(),
  weakHash:   integer("weak_hash", { mode: "number" }).notNull(),
  strongHash: text("strong_hash").notNull(),
}, (t) => [
  index("blocks_version_index_idx").on(t.versionId, t.blockIndex),
  index("blocks_weak_hash_idx").on(t.weakHash),
]);

export const syncJobs = sqliteTable("sync_jobs", {
  id:               text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId:           text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  fileId:           text("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
  direction:        text("direction").notNull().$type<"push" | "pull">(),
  bytesTransferred: integer("bytes_transferred", { mode: "number" }).notNull().default(0),
  bytesSaved:       integer("bytes_saved",       { mode: "number" }).notNull().default(0),
  status:           text("status").notNull().default("done").$type<"pending"|"running"|"done"|"error">(),
  startedAt:        integer("started_at", { mode: 'timestamp_ms' }).$defaultFn(() => new Date()).notNull(),
  finishedAt:       integer("finished_at", { mode: 'timestamp_ms' }),
  error:            text("error"),
}, (t) => [
  index("sync_jobs_user_started_idx").on(t.userId, t.startedAt),
]);

export const apiKeys = sqliteTable("api_keys", {
  id:         text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId:     text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  keyHash:    text("key_hash").notNull(),
  prefix:     text("prefix").notNull(),
  label:      text("label").notNull(),
  lastUsedAt: integer("last_used_at", { mode: 'timestamp_ms' }),
  revokedAt:  integer("revoked_at", { mode: 'timestamp_ms' }),
  createdAt:  integer("created_at", { mode: 'timestamp_ms' }).$defaultFn(() => new Date()).notNull(),
}, (t) => [
  uniqueIndex("api_keys_key_hash_idx").on(t.keyHash),
]);

export const usersRelations = relations(users, ({ many }) => ({
  files:    many(files),
  syncJobs: many(syncJobs),
  apiKeys:  many(apiKeys),
}));
export const filesRelations = relations(files, ({ one, many }) => ({
  user:     one(users, { fields: [files.userId], references: [users.id] }),
  versions: many(fileVersions),
  syncJobs: many(syncJobs),
}));
export const fileVersionsRelations = relations(fileVersions, ({ one, many }) => ({
  file:   one(files, { fields: [fileVersions.fileId], references: [files.id] }),
  blocks: many(blocks),
}));
export const blocksRelations = relations(blocks, ({ one }) => ({
  version: one(fileVersions, { fields: [blocks.versionId], references: [fileVersions.id] }),
}));
export const syncJobsRelations = relations(syncJobs, ({ one }) => ({
  user: one(users, { fields: [syncJobs.userId], references: [users.id] }),
  file: one(files, { fields: [syncJobs.fileId],  references: [files.id] }),
}));
export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, { fields: [apiKeys.userId], references: [users.id] }),
}));

export const outboxEvents = sqliteTable("outbox_events", {
  id:          text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  eventType:   text("event_type").notNull().$type<
    "FILE_VERSION_CREATED" | "FILE_DELETED" | "GC_REQUESTED" | "CHUNK_VERIFICATION"
  >(),
  aggregateId: text("aggregate_id").notNull(),
  payload:     text("payload").notNull(), // JSON-encoded event data
  processedAt: integer("processed_at", { mode: 'timestamp_ms' }),
  createdAt:   integer("created_at", { mode: 'timestamp_ms' }).$defaultFn(() => new Date()).notNull(),
}, (t) => [
  index("outbox_events_unprocessed_idx").on(t.processedAt, t.createdAt),
]);

export const gcRuns = sqliteTable("gc_runs", {
  id:           text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  status:       text("status").notNull().default("running").$type<"running" | "completed" | "failed">(),
  deletedCount: integer("deleted_count").notNull().default(0),
  error:        text("error"),
  startedAt:    integer("started_at", { mode: 'timestamp_ms' }).$defaultFn(() => new Date()).notNull(),
  finishedAt:   integer("finished_at", { mode: 'timestamp_ms' }),
});

export type User         = typeof users.$inferSelect;
export type InsertUser   = typeof users.$inferInsert;
export type File         = typeof files.$inferSelect;
export type FileVersion  = typeof fileVersions.$inferSelect;
export type Block        = typeof blocks.$inferSelect;
export type SyncJob      = typeof syncJobs.$inferSelect;
export type ApiKey       = typeof apiKeys.$inferSelect;
export type OutboxEvent  = typeof outboxEvents.$inferSelect;
export type GcRun        = typeof gcRuns.$inferSelect;
