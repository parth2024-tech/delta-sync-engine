/**
 * Delta engine: fixed-size rolling (legacy) or content-defined chunking (CDC).
 * Weak hash: Adler-32 (matches server + historical clients).
 */

import { cdcRanges } from "../../shared/fastcdc.js";
import { adler32, sha256Hex } from "../../shared/hash.js";

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
  if (opts.chunking === "fixed") {
    const blockSize = opts.blockSize;
    const sigs: Signature[] = [];
    let offset = 0, idx = 0;
    while (offset < data.length) {
      const end = Math.min(offset + blockSize, data.length);
      const chunk = data.subarray(offset, end);
      sigs.push({
        blockIndex: idx++,
        weakHash:   adler32(chunk),
        strongHash: await sha256Hex(chunk),
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
      weakHash:   adler32(chunk),
      strongHash: await sha256Hex(chunk),
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
    const weak = adler32(newData.subarray(i, i + blockSize));
    const candidates = weakMap.get(weak16(weak));

    if (candidates) {
      const strong = await sha256Hex(newData.subarray(i, i + blockSize));
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
    const weak = adler32(slice);
    const strong = await sha256Hex(slice);
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
  return sha256Hex(data);
}
