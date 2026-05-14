import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { z } from "zod";
import { db } from "../../server/db";
import { apiKeys } from "../../shared/schema";
import { eq } from "drizzle-orm";
import { verifySessionToken } from "../../server/auth";
import { sha256Hex } from "./api-key-auth";

async function requireAuth() {
  const token = getCookie("ds_session");
  if (!token) throw new Error("Unauthorized");
  const userId = await verifySessionToken(token);
  if (!userId) throw new Error("Unauthorized");
  return userId;
}

function randomHex(bytes: number) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const createApiKey = createServerFn({ method: "POST" })
  .inputValidator(z.object({ label: z.string().min(1).max(64) }))
  .handler(async ({ data }) => {
    const userId = await requireAuth();
    const raw    = `dks_${randomHex(16)}`;
    const hash   = await sha256Hex(raw);
    const prefix = raw.slice(0, 8);
    await db.insert(apiKeys).values({ userId, keyHash: hash, prefix, label: data.label });
    return { key: raw };
  });

export const listApiKeys = createServerFn({ method: "GET" }).handler(async () => {
  const userId = await requireAuth();
  return db.select({
    id: apiKeys.id, prefix: apiKeys.prefix, label: apiKeys.label,
    lastUsedAt: apiKeys.lastUsedAt, revokedAt: apiKeys.revokedAt, createdAt: apiKeys.createdAt,
  }).from(apiKeys).where(eq(apiKeys.userId, userId));
});

export const revokeApiKey = createServerFn({ method: "POST" })
  .inputValidator(z.object({ id: z.string() }))
  .handler(async ({ data }) => {
    const userId = await requireAuth();
    await db.update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, data.id));
    return { ok: true };
  });
