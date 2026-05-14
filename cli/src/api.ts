import type { Config } from "./config.js";
import type { Op } from "./rsync.js";

function headers(cfg: Config) {
  return { "Authorization": `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" };
}

export async function listFiles(cfg: Config) {
  const r = await fetch(`${cfg.serverUrl}/api/public/sync/files`, { headers: headers(cfg) });
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<{ path: string; totalSize: number; currentVersionId: string }[]>;
}

export async function getSignatures(cfg: Config, path: string) {
  const r = await fetch(`${cfg.serverUrl}/api/public/sync/signatures`, {
    method: "POST", headers: headers(cfg), body: JSON.stringify({ path }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<{
    fileId: string; versionNo: number; blockSize: number;
    signatures: { blockIndex: number; weakHash: number; strongHash: string; offset: number; length: number }[];
  } | null>;
}

export async function upload(cfg: Config, body: {
  path: string; blockSize: number; newSize: number; contentSha256: string; ops: Op[];
}) {
  const r = await fetch(`${cfg.serverUrl}/api/public/sync/upload`, {
    method: "POST", headers: headers(cfg), body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<{ bytesSaved: number }>;
}

export async function download(cfg: Config, path: string, version?: number): Promise<Buffer> {
  const r = await fetch(`${cfg.serverUrl}/api/public/sync/download`, {
    method: "POST", headers: headers(cfg), body: JSON.stringify({ path, version }),
  });
  if (!r.ok) throw new Error(await r.text());
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}
