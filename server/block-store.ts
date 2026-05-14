/**
 * Phase 1 — Content-addressed block store.
 *
 * Physical block data lives here, keyed by its SHA-256 hex hash.
 * In development this is a local directory; swap the adapter for S3/R2 in prod.
 */

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";

const BLOCKS_DIR = ".deltasync-blocks";

async function ensureDir(): Promise<void> {
  await mkdir(BLOCKS_DIR, { recursive: true });
}

/** Persist a block. No-op if already stored (content-addressed = immutable). */
export async function storeBlock(hash: string, data: Uint8Array): Promise<void> {
  await ensureDir();
  const path = join(BLOCKS_DIR, hash);
  try {
    await access(path);
    // Already exists — content-addressed, identical bytes guaranteed.
  } catch {
    await writeFile(path, data);
  }
}

/** Retrieve a block by its SHA-256 hash. Throws if not found. */
export async function fetchBlock(hash: string): Promise<Uint8Array> {
  const path = join(BLOCKS_DIR, hash);
  const buf  = await readFile(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Check existence without loading the bytes. */
export async function hasBlock(hash: string): Promise<boolean> {
  try {
    await access(join(BLOCKS_DIR, hash));
    return true;
  } catch {
    return false;
  }
}
