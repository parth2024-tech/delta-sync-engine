import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CasLifecycleManager } from "../server/cas-lifecycle";
import { db } from "../server/db";
import { casBlockIndex } from "../shared/schema";
import { eq } from "drizzle-orm";
import { resetStorageAdapter } from "../server/storage-adapter";

describe("CasLifecycleManager", () => {
  const hash1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const hash2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const prevDriver = process.env.STORAGE_DRIVER;

  beforeEach(async () => {
    process.env.STORAGE_DRIVER = "local";
    resetStorageAdapter();
    await db.delete(casBlockIndex).where(eq(casBlockIndex.strongHash, hash1));
    await db.delete(casBlockIndex).where(eq(casBlockIndex.strongHash, hash2));
  });

  afterEach(async () => {
    process.env.STORAGE_DRIVER = prevDriver;
    resetStorageAdapter();
    await db.delete(casBlockIndex).where(eq(casBlockIndex.strongHash, hash1));
    await db.delete(casBlockIndex).where(eq(casBlockIndex.strongHash, hash2));
  });

  it("registers new references and increments counts on duplicate references", async () => {
    await CasLifecycleManager.registerReferences([
      { hash: hash1, size: 4096 },
      { hash: hash2, size: 8192 },
    ]);

    const [row1] = await db.select().from(casBlockIndex).where(eq(casBlockIndex.strongHash, hash1));
    expect(row1).toBeDefined();
    expect(row1.refCount).toBe(1);
    expect(row1.byteSize).toBe(4096);

    // Register hash1 again (deduplication scenario)
    await CasLifecycleManager.registerReferences([{ hash: hash1, size: 4096 }]);

    const [row1Updated] = await db
      .select()
      .from(casBlockIndex)
      .where(eq(casBlockIndex.strongHash, hash1));
    expect(row1Updated.refCount).toBe(2);
  });

  it("dereferences chunk hashes and saturates at 0", async () => {
    await CasLifecycleManager.registerReferences([{ hash: hash1, size: 4096 }]);
    await CasLifecycleManager.registerReferences([{ hash: hash1, size: 4096 }]);

    // Dereference once: 2 -> 1
    await CasLifecycleManager.dereference([hash1]);
    let [row] = await db.select().from(casBlockIndex).where(eq(casBlockIndex.strongHash, hash1));
    expect(row.refCount).toBe(1);

    // Dereference again: 1 -> 0
    await CasLifecycleManager.dereference([hash1]);
    [row] = await db.select().from(casBlockIndex).where(eq(casBlockIndex.strongHash, hash1));
    expect(row.refCount).toBe(0);

    // Dereference beyond 0: saturates at 0
    await CasLifecycleManager.dereference([hash1]);
    [row] = await db.select().from(casBlockIndex).where(eq(casBlockIndex.strongHash, hash1));
    expect(row.refCount).toBe(0);
  });

  it("sweeps quarantined blocks whose ref_count <= 0 and grace period expired", async () => {
    await CasLifecycleManager.registerReferences([{ hash: hash1, size: 4096 }]);
    await CasLifecycleManager.dereference([hash1]);

    // Fast-forward lastReferencedAt into the past
    const pastDate = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago
    await db
      .update(casBlockIndex)
      .set({ lastReferencedAt: pastDate })
      .where(eq(casBlockIndex.strongHash, hash1));

    // Sweep with 10 minute grace period -> should sweep hash1
    const swept = await CasLifecycleManager.sweepQuarantinedBlocks(10 * 60 * 1000);
    expect(swept).toBeGreaterThanOrEqual(1);

    const [row] = await db.select().from(casBlockIndex).where(eq(casBlockIndex.strongHash, hash1));
    expect(row).toBeUndefined();
  });
});
