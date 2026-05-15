import {
  pgTable, text, integer, bigint, timestamp, uniqueIndex, index, customType,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

/** Raw PostgreSQL bytea for packed chunk manifests (one blob per version). */
export const bytea = customType<{ data: Buffer | null; driverData: Buffer | null }>({
  dataType() {
    return "bytea";
  },
  toDriver(value: Buffer | null): Buffer | null {
    return value;
  },
  fromDriver(value: unknown): Buffer | null {
    if (value == null) return null;
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    return Buffer.from(String(value), "binary");
  },
});

export const users = pgTable("users", {
  id:           text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  email:        text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName:  text("display_name").notNull().default(""),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
});

export const files = pgTable("files", {
  id:               text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId:           text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  path:             text("path").notNull(),
  currentVersionId: text("current_version_id"),
  totalSize:        bigint("total_size", { mode: "number" }).notNull().default(0),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("files_user_path_unique").on(t.userId, t.path),
  index("files_user_id_idx").on(t.userId),
]);

export const fileVersions = pgTable("file_versions", {
  id:            text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  fileId:        text("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
  versionNo:     integer("version_no").notNull(),
  size:          bigint("size", { mode: "number" }).notNull().default(0),
  totalBlocks:   integer("total_blocks").notNull().default(0),
  blockSize:     integer("block_size").notNull().default(4096),
  /** Packed chunk list (offset, length, weak, strong×32). Replaces per-row `blocks` for new versions. */
  chunkManifest: bytea("chunk_manifest"),
  /** `cdc` = content-defined chunks; `fixed` = legacy fixed-size blocks. */
  chunkingMode:  text("chunking_mode").notNull().default("fixed").$type<"cdc" | "fixed">(),
  contentSha256: text("content_sha256").notNull().default(""),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("file_versions_file_verno_unique").on(t.fileId, t.versionNo),
]);

// Phase 1: data column removed — binary content lives in the block-store (local FS / S3-compatible)
// keyed by strongHash (SHA-256).  offset and length are derivable:
//   offset = blockIndex * blockSize   length = min(blockSize, version.size - offset)
export const blocks = pgTable("blocks", {
  id:         text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  versionId:  text("version_id").notNull().references(() => fileVersions.id, { onDelete: "cascade" }),
  blockIndex: integer("block_index").notNull(),
  weakHash:   bigint("weak_hash", { mode: "number" }).notNull(),
  strongHash: text("strong_hash").notNull(),
}, (t) => [
  index("blocks_version_index_idx").on(t.versionId, t.blockIndex),
  index("blocks_weak_hash_idx").on(t.weakHash),
]);

export const syncJobs = pgTable("sync_jobs", {
  id:               text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId:           text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  fileId:           text("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
  direction:        text("direction").notNull().$type<"push" | "pull">(),
  bytesTransferred: bigint("bytes_transferred", { mode: "number" }).notNull().default(0),
  bytesSaved:       bigint("bytes_saved",       { mode: "number" }).notNull().default(0),
  status:           text("status").notNull().default("done").$type<"pending"|"running"|"done"|"error">(),
  startedAt:        timestamp("started_at").defaultNow().notNull(),
  finishedAt:       timestamp("finished_at"),
  error:            text("error"),
}, (t) => [
  index("sync_jobs_user_started_idx").on(t.userId, t.startedAt),
]);

export const apiKeys = pgTable("api_keys", {
  id:         text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId:     text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  keyHash:    text("key_hash").notNull(),
  prefix:     text("prefix").notNull(),
  label:      text("label").notNull(),
  lastUsedAt: timestamp("last_used_at"),
  revokedAt:  timestamp("revoked_at"),
  createdAt:  timestamp("created_at").defaultNow().notNull(),
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

// ── Transactional Outbox (Step 3: Event-Driven Architecture) ──────────────────

/**
 * Outbox events table — implements the Transactional Outbox Pattern.
 *
 * Events are inserted atomically within the same DB transaction as the
 * business operation (e.g., creating a file_version). A background
 * dispatcher polls this table, dispatches to BullMQ, and marks as processed.
 *
 * Event types:
 *   - FILE_VERSION_CREATED — triggers chunk verification, indexing, etc.
 *   - FILE_DELETED — triggers S3 cleanup
 *   - GC_REQUESTED — triggers garbage collection run
 */
export const outboxEvents = pgTable("outbox_events", {
  id:          text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  eventType:   text("event_type").notNull().$type<
    "FILE_VERSION_CREATED" | "FILE_DELETED" | "GC_REQUESTED" | "CHUNK_VERIFICATION"
  >(),
  aggregateId: text("aggregate_id").notNull(),
  payload:     text("payload").notNull(), // JSON-encoded event data
  processedAt: timestamp("processed_at"),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("outbox_events_unprocessed_idx").on(t.processedAt, t.createdAt),
]);

// ── GC Runs Tracking (Step 4: Offline GC History) ─────────────────────────────

export const gcRuns = pgTable("gc_runs", {
  id:           text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  status:       text("status").notNull().default("running").$type<"running" | "completed" | "failed">(),
  deletedCount: integer("deleted_count").notNull().default(0),
  error:        text("error"),
  startedAt:    timestamp("started_at").defaultNow().notNull(),
  finishedAt:   timestamp("finished_at"),
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
