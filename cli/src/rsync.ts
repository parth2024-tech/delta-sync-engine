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
import fs from "node:fs";
import crypto from "node:crypto";

import { cdcRanges } from "../../shared/fastcdc.js";
import { adler32, sha256Hex } from "../../shared/hash.js";

export { encodeOpsBinaryV1 } from "../../shared/ops-binary.js";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface NativeAddon {
  isNative: boolean;
  cdcChunkAndHash: (
    data: Buffer,
    blockSize: number,
  ) => Promise<{
    chunks: {
      blockIndex: number;
      weakHash: number;
      strongHashHex: string;
      offset: number;
      length: number;
    }[];
  }>;
  adler32Native: (data: Buffer) => number;
  sha256Native: (data: Buffer) => string;
}

function getNativeAddon(): NativeAddon {
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
    cdcChunkAndHash: null as unknown as NativeAddon["cdcChunkAndHash"],
    adler32Native: null as unknown as NativeAddon["adler32Native"],
    sha256Native: null as unknown as NativeAddon["sha256Native"],
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
  if (fileSize < SMALL_FILE_THRESHOLD) return 0; // skip CDC
  if (fileSize < 256 * 1024) return 4096; // 4 KiB avg
  if (fileSize < 10 * 1024 * 1024) return 16384; // 16 KiB avg (default)
  return 65536; // 64 KiB avg
}

export interface Signature {
  blockIndex: number;
  weakHash: number;
  strongHash: string;
  offset: number;
  length: number;
}

export type Op =
  | { type: "copy"; blockIndex: number }
  | { type: "literal"; literalOffset: number; literalLength: number };

export interface DeltaResult {
  ops: Op[];
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
      return res.chunks.map((c) => ({
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
    let offset = 0,
      idx = 0;
    while (offset < data.length) {
      const end = Math.min(offset + blockSize, data.length);
      const chunk = data.subarray(offset, end);
      sigs.push({
        blockIndex: idx++,
        weakHash: nativeAddon.isNative ? nativeAddon.adler32Native(chunk) : adler32(chunk),
        strongHash: nativeAddon.isNative
          ? await nativeAddon.sha256Native(chunk)
          : await sha256Hex(chunk),
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
      weakHash: nativeAddon.isNative ? nativeAddon.adler32Native(chunk) : adler32(chunk),
      strongHash: nativeAddon.isNative
        ? await nativeAddon.sha256Native(chunk)
        : await sha256Hex(chunk),
      offset: start,
      length: end - start,
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
      ops: [{ type: "literal", literalOffset: 0, literalLength: newData.length }],
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
      const strong = nativeAddon.isNative
        ? await nativeAddon.sha256Native(slice)
        : await sha256Hex(slice);
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
    const strong = nativeAddon.isNative
      ? await nativeAddon.sha256Native(slice)
      : await sha256Hex(slice);
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

/**
 * Computes SHA-256 for a file of arbitrary size (MBs to TBs) using bounded 64KB streaming.
 * Memory allocated: strictly <= 64 KB, eliminating OOM.
 */
export async function contentHashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Reads a single chunk slice on-demand directly from disk.
 * Allows parallel uploads of multi-gigabyte files without holding the entire file in RAM.
 */
export async function readChunkSlice(
  filePath: string,
  offset: number,
  length: number,
): Promise<Buffer> {
  const fd = await fs.promises.open(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await fd.read(buf, 0, length, offset);
    return bytesRead === length ? buf : buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
}

/**
 * Generates chunk signatures for a file of arbitrary size.
 * For small files (< 32 MB), loads into memory for max speed.
 * For large files (>= 32 MB), processes via a bounded 2 MB sliding buffer.
 */
export async function buildSignaturesFromFile(
  filePath: string,
  opts: BuildSigOpts,
): Promise<Signature[]> {
  const stat = fs.statSync(filePath);
  if (stat.size <= 32 * 1024 * 1024) {
    const data = fs.readFileSync(filePath);
    return buildSignatures(data, opts);
  }

  // Large-file streaming window chunking (bounded to 2 MB heap)
  const fd = await fs.promises.open(filePath, "r");
  const WINDOW_SIZE = 2 * 1024 * 1024;
  const windowBuf = Buffer.allocUnsafe(WINDOW_SIZE);
  let bytesInWindow = 0;
  let fileOffset = 0;
  let globalChunkOffset = 0;
  const sigs: Signature[] = [];
  let blockIndex = 0;

  try {
    while (fileOffset < stat.size || bytesInWindow > 0) {
      if (bytesInWindow < WINDOW_SIZE && fileOffset < stat.size) {
        const toRead = Math.min(WINDOW_SIZE - bytesInWindow, stat.size - fileOffset);
        const { bytesRead } = await fd.read(windowBuf, bytesInWindow, toRead, fileOffset);
        bytesInWindow += bytesRead;
        fileOffset += bytesRead;
      }

      if (bytesInWindow === 0) break;

      const activeSlice = windowBuf.subarray(0, bytesInWindow);
      const isEof = fileOffset >= stat.size;

      if (opts.chunking === "fixed") {
        const blockSize = opts.blockSize;
        let p = 0;
        while (p + blockSize <= bytesInWindow || (isEof && p < bytesInWindow)) {
          const end = Math.min(p + blockSize, bytesInWindow);
          const chunk = activeSlice.subarray(p, end);
          sigs.push({
            blockIndex: blockIndex++,
            weakHash: nativeAddon.isNative ? nativeAddon.adler32Native(chunk) : adler32(chunk),
            strongHash: nativeAddon.isNative
              ? await nativeAddon.sha256Native(chunk)
              : await sha256Hex(chunk),
            offset: globalChunkOffset,
            length: chunk.length,
          });
          globalChunkOffset += chunk.length;
          p = end;
        }
        if (p < bytesInWindow) {
          windowBuf.copyWithin(0, p, bytesInWindow);
          bytesInWindow -= p;
        } else {
          bytesInWindow = 0;
        }
      } else {
        const avg = opts.blockSize;
        const ends = cdcRanges(activeSlice, {
          minSize: Math.max(512, Math.floor(avg / 4)),
          avgSize: avg,
          maxSize: Math.min(1024 * 1024, avg * 64),
        });

        if (ends.length === 0) {
          if (isEof) {
            const chunk = activeSlice;
            sigs.push({
              blockIndex: blockIndex++,
              weakHash: nativeAddon.isNative ? nativeAddon.adler32Native(chunk) : adler32(chunk),
              strongHash: nativeAddon.isNative
                ? await nativeAddon.sha256Native(chunk)
                : await sha256Hex(chunk),
              offset: globalChunkOffset,
              length: chunk.length,
            });
            bytesInWindow = 0;
          }
          break;
        }

        const processCount = isEof ? ends.length : Math.max(1, ends.length - 1);
        let lastCut = 0;
        for (let i = 0; i < processCount; i++) {
          const { start, end } = ends[i]!;
          const chunk = activeSlice.subarray(start, end);
          sigs.push({
            blockIndex: blockIndex++,
            weakHash: nativeAddon.isNative ? nativeAddon.adler32Native(chunk) : adler32(chunk),
            strongHash: nativeAddon.isNative
              ? await nativeAddon.sha256Native(chunk)
              : await sha256Hex(chunk),
            offset: globalChunkOffset,
            length: chunk.length,
          });
          globalChunkOffset += chunk.length;
          lastCut = end;
        }

        windowBuf.copyWithin(0, lastCut, bytesInWindow);
        bytesInWindow -= lastCut;
      }
    }
  } finally {
    await fd.close();
  }

  return sigs;
}
