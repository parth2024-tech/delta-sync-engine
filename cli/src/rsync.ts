/**
 * Delta engine: fixed-size rolling (legacy) or content-defined chunking (CDC).
 * Weak hash: Adler-32 (matches server + historical clients).
 *
 * Adaptive chunk sizing:
 *   < 32 KB  → per-file hash comparison (skip CDC entirely)
 *   32–256 KB → CDC with 4 KiB average
 *   256 KB–10 MB → CDC with 16 KiB average (default)
 *   > 10 MB → CDC with 64 KiB average (fewer chunks, faster hashing)
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cdcRanges } from "../../shared/fastcdc.js";
import { adler32, sha256Hex } from "../../shared/hash.js";

export { encodeOpsBinaryV1 } from "../../shared/ops-binary.js";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getNativeAddon() {
  const potentialPaths = [
    // In dev mode running from cli/src/rsync.ts
    path.join(__dirname, "../../../native/deltasync-native.node"),
    // In compiled dist mode running from cli/dist/cli/src/rsync.js
    path.join(__dirname, "../../../../native/deltasync-native.node"),
    // Relative to execution directory
    path.join(process.cwd(), "native/deltasync-native.node"),
  ];

  for (const p of potentialPaths) {
    try {
      const addon = require(p);
      return {
        isNative: true,
        cdcChunkAndHash: addon.cdcChunkAndHash,
        adler32Native: addon.adler32Native,
        sha256Native: addon.sha256Native,
      };
    } catch {
      // Ignore and try next path
    }
  }

  return {
    isNative: false,
    cdcChunkAndHash: null as any,
    adler32Native: null as any,
    sha256Native: null as any,
  };
}

const nativeAddon = getNativeAddon();

/** Files smaller than this skip CDC entirely and use whole-file hash comparison. */
export const SMALL_FILE_THRESHOLD = 32 * 1024; // 32 KB

/**
 * Select an optimal CDC average chunk size based on file size.
 * Returns 0 for files below the small-file threshold (meaning: skip CDC).
 */
export function adaptiveChunkSize(fileSize: number): number {
  if (fileSize < SMALL_FILE_THRESHOLD) return 0;       // skip CDC
  if (fileSize < 256 * 1024) return 4096;               // 4 KiB avg
  if (fileSize < 10 * 1024 * 1024) return 16384;        // 16 KiB avg (default)
  return 65536;                                          // 64 KiB avg
}

export interface Signature {
  blockIndex: number;
  weakHash:   number;
  strongHash: string;
  offset:     number;
  length:     number;
}

export type Op =
  | { type: "copy";    blockIndex: number }
  | { type: "literal"; literalOffset: number; literalLength: number };

export interface DeltaResult {
  ops:          Op[];
  literalBytes: Buffer;
}

function weak16(w: number): number {
  return w & 0xffff;
}

export interface BuildSigOpts {
  chunking: "cdc" | "fixed";
  blockSize: number;
}

export async function buildSignatures(data: Buffer, opts: BuildSigOpts): Promise<Signature[]> {
  if (nativeAddon.isNative && opts.chunking === "cdc") {
    try {
      const res = await nativeAddon.cdcChunkAndHash(data, opts.blockSize);
      return res.chunks.map((c: any) => ({
        blockIndex: c.blockIndex,
        weakHash: c.weakHash,
        strongHash: c.strongHashHex,
        offset: c.offset,
        length: c.length,
      }));
    } catch (err) {
      console.warn("[CLI:Rsync] Native signature calculation failed, falling back to JS:", err);
    }
  }

  if (opts.chunking === "fixed") {
    const blockSize = opts.blockSize;
    const sigs: Signature[] = [];
    let offset = 0, idx = 0;
    while (offset < data.length) {
      const end = Math.min(offset + blockSize, data.length);
      const chunk = data.subarray(offset, end);
      sigs.push({
        blockIndex: idx++,
        weakHash:   nativeAddon.isNative ? nativeAddon.adler32Native(chunk) : adler32(chunk),
        strongHash: nativeAddon.isNative ? await nativeAddon.sha256Native(chunk) : await sha256Hex(chunk),
        offset,
        length: end - offset,
      });
      offset = end;
    }
    return sigs;
  }

  const avg = opts.blockSize;
  const ranges = cdcRanges(data, {
    minSize: Math.max(512, Math.floor(avg / 4)),
    avgSize: avg,
    maxSize: Math.min(4 * 1024 * 1024, avg * 64),
  });

  const sigs: Signature[] = [];
  let idx = 0;
  for (const { start, end } of ranges) {
    const chunk = data.subarray(start, end);
    sigs.push({
      blockIndex: idx++,
      weakHash:   nativeAddon.isNative ? nativeAddon.adler32Native(chunk) : adler32(chunk),
      strongHash: nativeAddon.isNative ? await nativeAddon.sha256Native(chunk) : await sha256Hex(chunk),
      offset:     start,
      length:     end - start,
    });
  }
  return sigs;
}

export async function computeDelta(
  newData: Buffer,
  remoteSigs: Signature[],
  opts: BuildSigOpts,
): Promise<DeltaResult> {
  if (!remoteSigs.length) {
    return {
      ops:          [{ type: "literal", literalOffset: 0, literalLength: newData.length }],
      literalBytes: newData,
    };
  }

  if (opts.chunking === "fixed") {
    return computeDeltaFixed(newData, remoteSigs, opts.blockSize);
  }
  return computeDeltaCdc(newData, remoteSigs, opts);
}

async function computeDeltaFixed(
  newData: Buffer,
  remoteSigs: Signature[],
  blockSize: number,
): Promise<DeltaResult> {
  const weakMap = new Map<number, Signature[]>();
  for (const s of remoteSigs) {
    const bucket = weakMap.get(weak16(s.weakHash));
    if (bucket) bucket.push(s);
    else weakMap.set(weak16(s.weakHash), [s]);
  }

  const ops: Op[] = [];
  const literalParts: Buffer[] = [];
  let literalCursor = 0;

  let i = 0;
  let litStart = 0;

  const flushLiteral = (until: number) => {
    if (until > litStart) {
      const chunk = newData.subarray(litStart, until);
      ops.push({ type: "literal", literalOffset: literalCursor, literalLength: chunk.length });
      literalParts.push(Buffer.from(chunk));
      literalCursor += chunk.length;
    }
  };

  while (i <= newData.length - blockSize) {
    const slice = newData.subarray(i, i + blockSize);
    const weak = nativeAddon.isNative ? nativeAddon.adler32Native(slice) : adler32(slice);
    const candidates = weakMap.get(weak16(weak));

    if (candidates) {
      const strong = nativeAddon.isNative ? await nativeAddon.sha256Native(slice) : await sha256Hex(slice);
      const match = candidates.find((c) => c.weakHash === weak && c.strongHash === strong);
      if (match) {
        flushLiteral(i);
        ops.push({ type: "copy", blockIndex: match.blockIndex });
        i += blockSize;
        litStart = i;
        continue;
      }
    }
    i++;
  }

  flushLiteral(newData.length);

  return { ops, literalBytes: Buffer.concat(literalParts) };
}

async function computeDeltaCdc(
  newData: Buffer,
  remoteSigs: Signature[],
  opts: BuildSigOpts,
): Promise<DeltaResult> {
  const weakMap = new Map<number, Signature[]>();
  for (const s of remoteSigs) {
    const bucket = weakMap.get(weak16(s.weakHash));
    if (bucket) bucket.push(s);
    else weakMap.set(weak16(s.weakHash), [s]);
  }

  const avg = opts.blockSize;
  const ranges = cdcRanges(newData, {
    minSize: Math.max(512, Math.floor(avg / 4)),
    avgSize: avg,
    maxSize: Math.min(4 * 1024 * 1024, avg * 64),
  });

  const ops: Op[] = [];
  const literalParts: Buffer[] = [];
  let literalCursor = 0;

  for (const { start, end } of ranges) {
    const slice = newData.subarray(start, end);
    const weak = nativeAddon.isNative ? nativeAddon.adler32Native(slice) : adler32(slice);
    const strong = nativeAddon.isNative ? await nativeAddon.sha256Native(slice) : await sha256Hex(slice);
    const candidates = weakMap.get(weak16(weak));
    const match = candidates?.find(
      (c) => c.weakHash === weak && c.strongHash === strong && c.length === slice.length,
    );

    if (match) {
      ops.push({ type: "copy", blockIndex: match.blockIndex });
    } else {
      ops.push({ type: "literal", literalOffset: literalCursor, literalLength: slice.length });
      literalParts.push(Buffer.from(slice));
      literalCursor += slice.length;
    }
  }

  return { ops, literalBytes: Buffer.concat(literalParts) };
}

export async function contentHash(data: Buffer): Promise<string> {
  return nativeAddon.isNative ? nativeAddon.sha256Native(data) : sha256Hex(data);
}
