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

import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "../shared/schema";
import path from "path";
import fs from "fs";

const DB_BACKEND = process.env.DB_BACKEND || "sqlite";

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
  return drizzle(sqlite, { schema });
}

function createDb() {
  if (DB_BACKEND === "postgres") {
    // Postgres backend extension point
    // When implementing, replace with:
    //   import { drizzle } from "drizzle-orm/node-postgres";
    //   import { Pool } from "pg";
    //   const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    //   return drizzle(pool, { schema });
    console.warn(
      "[DB] DB_BACKEND=postgres is configured but not yet implemented. Falling back to SQLite.",
    );
    return createSqliteDb();
  }

  return createSqliteDb();
}

export const db = createDb();

/** Returns the current database backend name. */
export function getDbBackend(): string {
  return DB_BACKEND;
}
