import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "../shared/schema";
import path from "path";
import fs from "fs";

// Create db directory if it doesn't exist
const dbDir = path.resolve(process.cwd(), ".deltasync");
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const sqlite = new Database(path.join(dbDir, "sqlite.db"));
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite, { schema });
