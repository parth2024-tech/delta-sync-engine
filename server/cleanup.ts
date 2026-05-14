import { sql } from "drizzle-orm";
import { db } from "./db";

export async function cleanupSyncJobs() {
  console.log("Starting DB Cleanup for old sync_jobs...");
  try {
    const res = await db.execute(sql`DELETE FROM sync_jobs WHERE finished_at < NOW() - INTERVAL '30 days'`);
    console.log(`Cleanup finished. Deleted old rows from sync_jobs.`);
  } catch (err) {
    console.error("Cleanup failed:", err);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cleanupSyncJobs().catch(console.error).finally(() => process.exit(0));
}
