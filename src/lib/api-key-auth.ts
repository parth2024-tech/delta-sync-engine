import { db } from "../../server/db";
import { apiKeys } from "../../shared/schema";
import { eq } from "drizzle-orm";

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function validateApiKey(authHeader: string | null | undefined): Promise<string | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const key = authHeader.slice(7).trim();
  if (!key) return null;
  const hash = await sha256Hex(key);
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash));
  const row = rows.find((r) => !r.revokedAt);
  if (!row) return null;
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));
  return row.userId;
}
