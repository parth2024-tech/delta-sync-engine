/**
 * Multipart upload: meta JSON + optional `opsBin` + raw literal bytes.
 */

import zlib from "node:zlib";
import fs from "node:fs";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { Config } from "./config.js";
import type { Op } from "./rsync.js";
import { generateTraceContext, formatTraceparent, type TraceContext } from "./telemetry.js";

export class NetworkError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "NetworkError";
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Executes a network fetch with bounded timeout enforced via AbortController.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 30000,
  traceCtx?: TraceContext,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(options.headers || {});
    if (!headers.has("Accept-Encoding")) {
      headers.set("Accept-Encoding", "gzip, deflate, br");
    }
    const ctx = traceCtx ?? generateTraceContext();
    if (!headers.has("traceparent")) {
      headers.set("traceparent", formatTraceparent(ctx));
    }
    return await fetch(url, { ...options, headers, signal: controller.signal });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    if (err instanceof Error) {
      throw new NetworkError(err.message);
    }
    throw new NetworkError(String(err));
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Full Jitter exponential backoff delay to prevent thundering herd on rate limits.
 */
export async function sleepWithJitter(
  attempt: number,
  baseDelay = 1000,
  maxDelay = 30000,
): Promise<void> {
  const exponential = baseDelay * Math.pow(2, attempt);
  const delay = Math.random() * Math.min(maxDelay, exponential);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

function authHeader(cfg: Config) {
  return { Authorization: `Bearer ${cfg.apiKey}` };
}

export async function listFiles(cfg: Config) {
  const r = await fetchWithTimeout(
    `${cfg.serverUrl}/api/public/sync/files`,
    {
      headers: authHeader(cfg),
    },
    15000,
  );
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<{ path: string; totalSize: number; currentVersionId: string }[]>;
}

export async function getSignatures(cfg: Config, path: string) {
  const r = await fetchWithTimeout(
    `${cfg.serverUrl}/api/public/sync/signatures`,
    {
      method: "POST",
      headers: { ...authHeader(cfg), "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    },
    30000,
  );
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<{
    fileId: string;
    versionNo: number;
    blockSize: number;
    chunking?: "cdc" | "fixed";
    signatures: {
      blockIndex: number;
      weakHash: number;
      strongHash: string;
      offset: number;
      length: number;
    }[];
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
    let payload = literalBytes;
    if (literalBytes.length > 1024) {
      try {
        const compressed = zlib.gzipSync(literalBytes);
        form.append("literalsEncoding", "gzip");
        payload = compressed;
      } catch {
        // Fallback to uncompressed if gzip fails
      }
    }
    form.append(
      "literals",
      new Blob([new Uint8Array(payload)], { type: "application/octet-stream" }),
      "literals.bin",
    );
  }

  const r = await fetchWithTimeout(
    `${cfg.serverUrl}/api/public/sync/upload`,
    {
      method: "POST",
      headers: authHeader(cfg),
      body: form,
    },
    60000,
  );
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<{ versionNo: number; bytesSaved: number }>;
}

export async function download(cfg: Config, path: string, version?: number): Promise<Buffer> {
  const r = await fetchWithTimeout(
    `${cfg.serverUrl}/api/public/sync/download`,
    {
      method: "POST",
      headers: { ...authHeader(cfg), "Content-Type": "application/json" },
      body: JSON.stringify({ path, version }),
    },
    60000,
  );
  if (!r.ok) throw new Error(await r.text());
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Downloads a file directly to disk using a bounded 64KB pipeline stream.
 * Automatically verifies downloaded SHA-256 without buffering the whole file in RAM.
 */
export async function downloadToFile(
  cfg: Config,
  remotePath: string,
  destinationPath: string,
  version?: number,
  expectedSha256?: string,
  highWaterMark = 64 * 1024,
): Promise<{ size: number; contentSha256: string }> {
  const r = await fetchWithTimeout(
    `${cfg.serverUrl}/api/public/sync/download`,
    {
      method: "POST",
      headers: { ...authHeader(cfg), "Content-Type": "application/json" },
      body: JSON.stringify({ path: remotePath, version }),
    },
    120000,
  );
  if (!r.ok) throw new Error(await r.text());
  if (!r.body) throw new Error("Empty download response body");

  const hash = crypto.createHash("sha256");
  let totalBytes = 0;

  // Stream directly to disk through crypto hash
  const nodeReadable = Readable.fromWeb(
    r.body as unknown as Parameters<typeof Readable.fromWeb>[0],
  );
  nodeReadable.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    totalBytes += chunk.length;
  });

  const fileWriteStream = fs.createWriteStream(destinationPath, { highWaterMark });
  await pipeline(nodeReadable, fileWriteStream);

  const finalSha256 = hash.digest("hex");
  if (expectedSha256 && finalSha256 !== expectedSha256) {
    throw new Error(
      `Downloaded file SHA-256 verification failed for ${destinationPath}: expected ${expectedSha256}, got ${finalSha256}`,
    );
  }

  return { size: totalBytes, contentSha256: finalSha256 };
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
  const r = await fetchWithTimeout(
    `${cfg.serverUrl}/api/public/sync/info`,
    {
      method: "POST",
      headers: { ...authHeader(cfg), "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    },
    15000,
  );
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
  },
): Promise<NegotiateResponse> {
  const r = await fetchWithTimeout(
    `${cfg.serverUrl}/api/public/sync/negotiate`,
    {
      method: "POST",
      headers: { ...authHeader(cfg), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    30000,
  );
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

export async function resumeNegotiation(
  cfg: Config,
  negotiationId: string,
): Promise<ResumeResponse> {
  const r = await fetchWithTimeout(
    `${cfg.serverUrl}/api/public/sync/resume`,
    {
      method: "POST",
      headers: { ...authHeader(cfg), "Content-Type": "application/json" },
      body: JSON.stringify({ negotiationId }),
    },
    30000,
  );
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<ResumeResponse>;
}

export async function commitSync(
  cfg: Config,
  negotiationId: string,
): Promise<{ versionNo: number; bytesSaved: number }> {
  const r = await fetchWithTimeout(
    `${cfg.serverUrl}/api/public/sync/commit`,
    {
      method: "POST",
      headers: { ...authHeader(cfg), "Content-Type": "application/json" },
      body: JSON.stringify({ negotiationId }),
    },
    60000,
  );
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<{ versionNo: number; bytesSaved: number }>;
}
