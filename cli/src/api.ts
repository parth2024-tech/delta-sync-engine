/**
 * Multipart upload: meta JSON + optional `opsBin` + raw literal bytes.
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

export type UploadMetaJson = {
  path: string;
  chunking: "cdc" | "fixed";
  blockSize: number;
  newSize: number;
  contentSha256: string;
  opsEncoding: "json" | "bin";
  opCount?: number;
  ops?: Op[];
};

/**
 * @param opsBin When set, `meta` must omit `ops` and use `opsEncoding: "bin"` + `opCount`.
 */
export async function upload(
  cfg: Config,
  meta: UploadMetaJson,
  literalBytes: Buffer,
  opsBin?: Buffer,
): Promise<{ versionNo: number; bytesSaved: number }> {
  const form = new FormData();
  form.append("meta", JSON.stringify(meta));
  if (opsBin && opsBin.length > 0) {
    form.append(
      "opsBin",
      new Blob([new Uint8Array(opsBin)], { type: "application/octet-stream" }),
      "ops.bin",
    );
  }
  if (literalBytes.length > 0) {
    form.append(
      "literals",
      new Blob([new Uint8Array(literalBytes)], { type: "application/octet-stream" }),
      "literals.bin",
    );
  }

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

export interface FileInfo {
  fileId: string;
  path: string;
  versionNo: number;
  size: number;
  contentSha256: string;
  verificationStatus: "pending" | "verified" | "corrupted";
}

/**
 * Fetch file metadata from the server without downloading binary content.
 * Returns null if the file doesn't exist on the server.
 */
export async function getFileInfo(cfg: Config, path: string): Promise<FileInfo | null> {
  const r = await fetch(`${cfg.serverUrl}/api/public/sync/info`, {
    method:  "POST",
    headers: { ...authHeader(cfg), "Content-Type": "application/json" },
    body:    JSON.stringify({ path }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<FileInfo | null>;
}

export interface NegotiateResponse {
  negotiationId: string;
  missingChunks: { index: number; strongHash: string; uploadUrl: string }[];
  totalChunks: number;
  existingChunks: number;
  presignExpiry: number;
}

export async function negotiate(
  cfg: Config,
  body: {
    path: string;
    chunking: "cdc" | "fixed";
    blockSize: number;
    newSize: number;
    contentSha256: string;
    chunks: { strongHash: string; length: number; weakHash?: number }[];
  }
): Promise<NegotiateResponse> {
  const r = await fetch(`${cfg.serverUrl}/api/public/sync/negotiate`, {
    method: "POST",
    headers: { ...authHeader(cfg), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<NegotiateResponse>;
}

export interface ResumeResponse {
  negotiationId: string;
  missingChunks: { strongHash: string; uploadUrl: string }[];
  totalChunks: number;
  alreadyUploaded: number;
  presignExpiry: number;
}

export async function resumeNegotiation(cfg: Config, negotiationId: string): Promise<ResumeResponse> {
  const r = await fetch(`${cfg.serverUrl}/api/public/sync/resume`, {
    method: "POST",
    headers: { ...authHeader(cfg), "Content-Type": "application/json" },
    body: JSON.stringify({ negotiationId }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<ResumeResponse>;
}

export async function commitSync(cfg: Config, negotiationId: string): Promise<{ versionNo: number; bytesSaved: number }> {
  const r = await fetch(`${cfg.serverUrl}/api/public/sync/commit`, {
    method: "POST",
    headers: { ...authHeader(cfg), "Content-Type": "application/json" },
    body: JSON.stringify({ negotiationId }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<{ versionNo: number; bytesSaved: number }>;
}
