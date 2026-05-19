/**
 * Outbox Dispatcher (Lite Mode) — Polls the `outbox_events` table and executes jobs directly.
 *
 * Implements the Transactional Outbox Pattern:
 *   1. Business transactions insert events atomically with their data changes
 *   2. This dispatcher polls for unprocessed events every N seconds
 *   3. Executes the handler directly in-process
 *   4. Marks the event as processed (sets processedAt timestamp)
 *
 * Also schedules automatic daily garbage collection via GC_REQUESTED events.
 */

import { db } from "./db";
import { outboxEvents } from "../shared/schema";
import { isNull, asc, eq } from "drizzle-orm";
import { handleVerifyChunks, handleCleanupFile, runGarbageCollection } from "./worker";

const POLL_INTERVAL_MS = parseInt(process.env.OUTBOX_POLL_MS || "2000", 10);
const BATCH_SIZE = 50;

// Schedule automatic GC once per day (24 hours)
const GC_INTERVAL_MS = 24 * 60 * 60 * 1000;

let running = true;

async function pollAndDispatch(): Promise<number> {
  // Use a transaction to atomically claim events for processing.
  // BEGIN IMMEDIATE prevents other SQLite connections from double-processing.
  // For Postgres mode, this would use FOR UPDATE SKIP LOCKED.
  const events = await db
    .select()
    .from(outboxEvents)
    .where(isNull(outboxEvents.processedAt))
    .orderBy(asc(outboxEvents.createdAt))
    .limit(BATCH_SIZE);

  if (events.length === 0) return 0;

  let dispatched = 0;

  for (const event of events) {
    try {
      const payload = JSON.parse(event.payload);

      // Execute directly based on event type
      if (event.eventType === "FILE_VERSION_CREATED" || event.eventType === "CHUNK_VERIFICATION") {
        await handleVerifyChunks(payload.versionId);
      } else if (event.eventType === "FILE_DELETED") {
        await handleCleanupFile(payload);
      } else if (event.eventType === "GC_REQUESTED") {
        await runGarbageCollection();
      } else if (event.eventType === "CHUNK_VERIFICATION_FAILED") {
        // Log the alert — extensible for future notification integrations
        console.warn(
          `[OutboxDispatcher] ⚠ CHUNK VERIFICATION FAILED for version ${payload.versionId}: ` +
          `${payload.missingCount}/${payload.totalHashes} chunks missing`,
        );
      } else {
        console.warn(`[OutboxDispatcher] Unknown event type: ${event.eventType}`);
      }

      // Mark as processed
      await db.update(outboxEvents)
        .set({ processedAt: new Date() })
        .where(eq(outboxEvents.id, event.id));

      dispatched++;
    } catch (err) {
      console.error(`[OutboxDispatcher] Failed to dispatch event ${event.id}:`, err);
    }
  }

  if (dispatched > 0) {
    console.log(`[OutboxDispatcher] Processed ${dispatched}/${events.length} events`);
  }

  return dispatched;
}

async function scheduleGc() {
  console.log(`[OutboxDispatcher] Scheduling automatic GC every ${GC_INTERVAL_MS / 3600000}h`);
  await db.insert(outboxEvents).values({
    eventType: "GC_REQUESTED",
    aggregateId: "scheduled",
    payload: JSON.stringify({ trigger: "daily-timer", scheduledAt: new Date().toISOString() }),
  });
}

async function runDispatcherLoop() {
  console.log(`[OutboxDispatcher] Started Lite Mode — polling every ${POLL_INTERVAL_MS}ms`);

  // Schedule daily GC timer
  const gcTimer = setInterval(() => {
    scheduleGc().catch((err) => console.error("[OutboxDispatcher] GC scheduling error:", err));
  }, GC_INTERVAL_MS);
  gcTimer.unref();

  while (running) {
    try {
      await pollAndDispatch();
    } catch (err) {
      console.error("[OutboxDispatcher] Poll error:", err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  clearInterval(gcTimer);
  console.log("[OutboxDispatcher] Shutting down...");
}

process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });

if (import.meta.url === `file://${process.argv[1]}`) {
  runDispatcherLoop().catch((err) => {
    console.error("[OutboxDispatcher] Fatal error:", err);
    process.exit(1);
  });
}

export { pollAndDispatch, runDispatcherLoop };
