/**
 * Phase 2 — CLI API client using multipart/form-data for upload.
 * No more base64 literals: raw bytes go in a binary form field.
 */

import type { Config } from "./config.js";
import type { Op } from "./rsync.js";

function authHeader(cfg: Config) {
  return { "Authorization": `Bearer ${cfg.apiKey}` };
}

export async function listFiles(cfg: Config) {
  const r = await fetch(`${cfg.serverUrl}/api/public/sync/files`, {
    headers: authHeader(cfg),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<{ path: string; totalSize: number; currentVersionId: string }[]>;
}

export async function getSignatures(cfg: Config, path: string) {
  const r = await fetch(`${cfg.serverUrl}/api/public/sync/signatures`, {
    method:  "POST",
    headers: { ...authHeader(cfg), "Content-Type": "application/json" },
    body:    JSON.stringify({ path }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<{
    fileId: string; versionNo: number; blockSize: number; chunking?: "cdc" | "fixed";
    signatures: { blockIndex: number; weakHash: number; strongHash: string; offset: number; length: number }[];
  } | null>;
}

/**
 * Phase 2 multipart upload — no base64 overhead.
 *
 * @param meta         JSON metadata: path, blockSize, newSize, contentSha256, ops
 *                     Literal ops carry { literalOffset, literalLength } into literalBytes.
 * @param literalBytes Concatenated raw bytes of all literal runs.
 */
export async function upload(
  cfg: Config,
  meta: { path: string; chunking: "cdc" | "fixed"; blockSize: number; newSize: number; contentSha256: string; ops: Op[] },
  literalBytes: Buffer,
): Promise<{ versionNo: number; bytesSaved: number }> {
  const form = new FormData();
  form.append("meta", JSON.stringify(meta));
  if (literalBytes.length > 0) {
    form.append(
      "literals",
      new Blob([new Uint8Array(literalBytes)], { type: "application/octet-stream" }),
      "literals.bin",
    );
  }

  // Do NOT set Content-Type — FormData sets it with the multipart boundary automatically
  const r = await fetch(`${cfg.serverUrl}/api/public/sync/upload`, {
    method:  "POST",
    headers: authHeader(cfg),
    body:    form,
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<{ versionNo: number; bytesSaved: number }>;
}

export async function download(cfg: Config, path: string, version?: number): Promise<Buffer> {
  const r = await fetch(`${cfg.serverUrl}/api/public/sync/download`, {
    method:  "POST",
    headers: { ...authHeader(cfg), "Content-Type": "application/json" },
    body:    JSON.stringify({ path, version }),
  });
  if (!r.ok) throw new Error(await r.text());
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}
