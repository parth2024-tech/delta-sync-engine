/**
 * Outbox Dispatcher — Polls the `outbox_events` table and dispatches to BullMQ.
 *
 * Implements the Transactional Outbox Pattern:
 *   1. Business transactions insert events atomically with their data changes
 *   2. This dispatcher polls for unprocessed events every N seconds
 *   3. Dispatches each event as a BullMQ job
 *   4. Marks the event as processed (sets processedAt timestamp)
 *
 * This guarantees at-least-once delivery without distributed transactions.
 * If a job fails, the worker's retry mechanism handles it — the outbox
 * ensures the event is never lost even if Redis goes down temporarily.
 *
 * Run: npx tsx --env-file=.env server/outbox-dispatcher.ts
 */

import { db, pool } from "./db";
import { outboxEvents } from "../shared/schema";
import { isNull, asc, eq } from "drizzle-orm";
import { Queue } from "bullmq";
import Redis from "ioredis";

const POLL_INTERVAL_MS = parseInt(process.env.OUTBOX_POLL_MS || "2000", 10);
const BATCH_SIZE = 50;

const redisConnection = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

/** BullMQ queue — same queue the worker listens on. */
const jobQueue = new Queue("background-jobs", { connection: redisConnection });

/**
 * Maps outbox event types to BullMQ job names.
 * This is the single source of truth for event → job routing.
 */
const EVENT_JOB_MAP: Record<string, string> = {
  FILE_VERSION_CREATED: "verify-chunks",
  FILE_DELETED:         "cleanup-file",
  GC_REQUESTED:         "run-gc",
  CHUNK_VERIFICATION:   "verify-chunks",
};

let running = true;

async function pollAndDispatch(): Promise<number> {
  // Fetch unprocessed events in creation order
  const events = await db
    .select()
    .from(outboxEvents)
    .where(isNull(outboxEvents.processedAt))
    .orderBy(asc(outboxEvents.createdAt))
    .limit(BATCH_SIZE);

  if (events.length === 0) return 0;

  let dispatched = 0;

  for (const event of events) {
    const jobName = EVENT_JOB_MAP[event.eventType] || event.eventType;

    try {
      // Parse the JSON payload and dispatch to BullMQ
      const payload = JSON.parse(event.payload);

      await jobQueue.add(jobName, {
        eventId: event.id,
        eventType: event.eventType,
        aggregateId: event.aggregateId,
        ...payload,
      }, {
        // Configurable retry with exponential backoff
        attempts: 5,
        backoff: {
          type: "exponential",
          delay: 3000,
        },
        // Remove completed jobs after 24h to prevent Redis bloat
        removeOnComplete: { age: 86400 },
        removeOnFail: { age: 604800 }, // keep failed jobs for 7 days
      });

      // Mark as processed
      await db.update(outboxEvents)
        .set({ processedAt: new Date() })
        .where(eq(outboxEvents.id, event.id));

      dispatched++;
    } catch (err) {
      console.error(`[OutboxDispatcher] Failed to dispatch event ${event.id}:`, err);
      // Don't mark as processed — it will be retried on next poll
    }
  }

  if (dispatched > 0) {
    console.log(`[OutboxDispatcher] Dispatched ${dispatched}/${events.length} events`);
  }

  return dispatched;
}

async function runDispatcherLoop() {
  console.log(`[OutboxDispatcher] Started — polling every ${POLL_INTERVAL_MS}ms (batch size: ${BATCH_SIZE})`);

  while (running) {
    try {
      await pollAndDispatch();
    } catch (err) {
      console.error("[OutboxDispatcher] Poll error:", err);
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  console.log("[OutboxDispatcher] Shutting down...");
  await jobQueue.close();
  await redisConnection.quit();
  await pool.end();
}

// Graceful shutdown
process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });

// Auto-start when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runDispatcherLoop().catch((err) => {
    console.error("[OutboxDispatcher] Fatal error:", err);
    process.exit(1);
  });
}

export { pollAndDispatch, runDispatcherLoop };
