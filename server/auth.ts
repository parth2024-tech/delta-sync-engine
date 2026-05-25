import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { validateEnvironment } from "./environment";

// Validate environment on module load
let config: ReturnType<typeof validateEnvironment>;
try {
  config = validateEnvironment();
} catch (err) {
  console.error("CRITICAL: Environment validation failed on startup");
  throw err;
}

const secret = new TextEncoder().encode(config.jwtSecret);

export async function hashPassword(password: string): Promise<string> {
  // Validate minimum password length before hashing
  if (!password || password.length < 8) {
    throw new Error("Password must be at least 8 characters long");
  }

  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createSessionToken(userId: string): Promise<string> {
  if (!userId) {
    throw new Error("userId is required");
  }

  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("30d")
    .sign(secret);
}

export async function verifySessionToken(
  token: string,
): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload.sub ?? null;
  } catch (err) {
    // Token verification failed (invalid, expired, tampered)
    return null;
  }
}
