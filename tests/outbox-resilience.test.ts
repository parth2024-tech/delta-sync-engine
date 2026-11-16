import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db } from "../server/db";
import { outboxEvents } from "../shared/schema";
import { pollAndDispatch } from "../server/outbox-dispatcher";
import { eq } from "drizzle-orm";

describe("Resilient Outbox Dispatcher & DLQ", () => {
  const poisonId = "test-poison-event-" + Date.now();
  const validId = "test-valid-event-" + Date.now();

  beforeEach(async () => {
    await db.delete(outboxEvents).where(eq(outboxEvents.id, poisonId));
    await db.delete(outboxEvents).where(eq(outboxEvents.id, validId));
  });

  afterEach(async () => {
    await db.delete(outboxEvents).where(eq(outboxEvents.id, poisonId));
    await db.delete(outboxEvents).where(eq(outboxEvents.id, validId));
  });

  it("increments attempt counter on failure without blocking queue", async () => {
    // Insert event with malformed JSON payload that triggers dispatch error
    await db.insert(outboxEvents).values({
      id: poisonId,
      eventType: "FILE_VERSION_CREATED",
      aggregateId: "agg-poison",
      payload: "NOT_VALID_JSON{",
      attempts: 0,
      createdAt: new Date(),
    });

    await pollAndDispatch();

    const [row] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, poisonId));
    expect(row).toBeDefined();
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBeDefined();
    expect(row.processedAt).toBeNull(); // Not yet dead-lettered
  });

  it("dead-letters poison events after reaching max attempts limit (5)", async () => {
    await db.insert(outboxEvents).values({
      id: poisonId,
      eventType: "FILE_VERSION_CREATED",
      aggregateId: "agg-poison",
      payload: "NOT_VALID_JSON{",
      attempts: 4, // 1 failure away from DLQ
      createdAt: new Date(),
    });

    await pollAndDispatch();

    const [row] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, poisonId));
    expect(row).toBeDefined();
    expect(row.attempts).toBe(5);
    expect(row.processedAt).not.toBeNull(); // Quarantined / dead-lettered
    expect(row.lastError).toContain("[DLQ]");
  });
});
