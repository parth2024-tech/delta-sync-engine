import { createServerFn } from "@tanstack/react-start";
import { getCookie, setCookie, deleteCookie } from "@tanstack/react-start/server";
import { z } from "zod";
import { db } from "../../server/db";
import { users } from "../../shared/schema";
import { eq } from "drizzle-orm";
import { hashPassword, verifyPassword, createSessionToken, verifySessionToken } from "../../server/auth";

const SESSION = "ds_session";

export const signUp = createServerFn({ method: "POST" })
  .inputValidator(z.object({
    email:       z.string().email(),
    password:    z.string().min(8),
    displayName: z.string().min(1),
  }))
  .handler(async ({ data }) => {
    const existing = await db.select().from(users).where(eq(users.email, data.email));
    if (existing.length > 0) throw new Error("Email already registered");
    const hash = await hashPassword(data.password);
    const [user] = await db.insert(users).values({
      email: data.email, passwordHash: hash, displayName: data.displayName,
    }).returning();
    const token = await createSessionToken(user.id);
    setCookie(SESSION, token, { httpOnly: true, sameSite: "lax", maxAge: 2592000, path: "/" });
    return { userId: user.id };
  });

export const signIn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ email: z.string().email(), password: z.string() }))
  .handler(async ({ data }) => {
    const [user] = await db.select().from(users).where(eq(users.email, data.email));
    if (!user) throw new Error("Invalid credentials");
    const ok = await verifyPassword(data.password, user.passwordHash);
    if (!ok) throw new Error("Invalid credentials");
    const token = await createSessionToken(user.id);
    setCookie(SESSION, token, { httpOnly: true, sameSite: "lax", maxAge: 2592000, path: "/" });
    return { userId: user.id };
  });

export const signOut = createServerFn({ method: "POST" }).handler(async () => {
  deleteCookie(SESSION);
  return { ok: true };
});

export const getSession = createServerFn({ method: "GET" }).handler(async () => {
  const token = getCookie(SESSION);
  if (!token) return null;
  const userId = await verifySessionToken(token);
  if (!userId) return null;
  const rows = await db.select({
    id: users.id, email: users.email, displayName: users.displayName,
  }).from(users).where(eq(users.id, userId));
  return rows[0] ?? null;
});
