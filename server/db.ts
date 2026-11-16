/**
 * Database factory — Returns a Drizzle database connection based on DB_BACKEND env var.
 *
 * Backends:
 *   - `sqlite` (default, Lite Mode): better-sqlite3 + Drizzle ORM
 *   - `postgres`: pg pool + Drizzle ORM (for multi-instance deployments)
 *
 * All imports of `./db` remain unchanged — this module is the single source of truth.
 *
 * Set `DB_BACKEND=postgres` and `DATABASE_URL=postgres://...` to enable Postgres mode.
 */

import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import Database from "better-sqlite3";
import pg from "pg";
const { Pool } = pg;
import * as schema from "../shared/schema";
import path from "path";
import fs from "fs";

const isPostgresConfigured =
  process.env.DB_BACKEND === "postgres" ||
  (process.env.NODE_ENV !== "test" &&
    process.env.DB_BACKEND !== "sqlite" &&
    Boolean(process.env.DATABASE_URL?.startsWith("postgres")));

const DB_BACKEND = isPostgresConfigured ? "postgres" : "sqlite";

let pgPool: pg.Pool | null = null;

function createSqliteDb() {
  const dbDir = path.resolve(process.cwd(), ".deltasync");
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  const sqlite = new Database(path.join(dbDir, "sqlite.db"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  // Enable aggressive busy timeout for concurrent access
  sqlite.pragma("busy_timeout = 10000");
  return drizzleSqlite(sqlite, { schema });
}

function createPgDb() {
  const connectionString = process.env.DATABASE_URL || "postgres://localhost:5432/deltasync";
  pgPool = new Pool({
    connectionString,
    max: parseInt(process.env.PG_MAX_POOL || "20", 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  console.info("[DB] Initialized PostgreSQL connection pool with Drizzle ORM");
  return drizzlePg(pgPool, { schema });
}

function createDb() {
  if (DB_BACKEND === "postgres") {
    return createPgDb() as unknown as ReturnType<typeof createSqliteDb>;
  }
  return createSqliteDb();
}

export const db = createDb();

/** Returns the current database backend name. */
export function getDbBackend(): string {
  return DB_BACKEND;
}

/** Close active database connections during graceful shutdown. */
export async function closeDb(): Promise<void> {
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }
}
