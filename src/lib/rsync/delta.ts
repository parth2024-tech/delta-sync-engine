/**
 * Delta computation: fixed-size rolling window (legacy) or CDC on the new file.
 */

import {
  adler32,
  adler32Hash,
  rollAdler32,
  weak16,
  type Adler32State,
} from "./adler32";
import { sha256 } from "./strong-hash";
import type { BlockSignature, ChunkingMode } from "./signatures";
import { cdcRanges } from "../../../shared/fastcdc";

export type DeltaOp =
  | { type: "copy";    blockIndex: number; offset: number; length: number }
  | { type: "literal"; offset: number;     bytes: Uint8Array };

export interface DeltaStats {
  totalNewBytes: number;
  copiedBytes:   number;
  literalBytes:  number;
  reusedBlocks:  number;
  newLiteralRuns: number;
}

export interface DeltaResult {
  ops:       DeltaOp[];
  stats:     DeltaStats;
  blockSize: number;
  mode:      ChunkingMode;
}

function buildBucketsFixed(sigs: BlockSignature[], blockSize: number): Map<number, BlockSignature[]> {
  const buckets = new Map<number, BlockSignature[]>();
  for (const sig of sigs) {
    if (sig.length !== blockSize) continue;
    const key  = weak16(sig.weak);
    const list = buckets.get(key);
    if (list) list.push(sig);
    else buckets.set(key, [sig]);
  }
  return buckets;
}

function buildBucketsAll(sigs: BlockSignature[]): Map<number, BlockSignature[]> {
  const buckets = new Map<number, BlockSignature[]>();
  for (const sig of sigs) {
    const key  = weak16(sig.weak);
    const list = buckets.get(key);
    if (list) list.push(sig);
    else buckets.set(key, [sig]);
  }
  return buckets;
}

export async function computeDelta(
  newBytes: Uint8Array,
  oldSignatures: BlockSignature[],
  blockSize: number,
  mode: ChunkingMode = "cdc",
): Promise<DeltaResult> {
  const results: DeltaOp[] = [];

  for await (const op of computeDeltaChunked(newBytes, oldSignatures, blockSize, mode)) {
    results.push(op);
  }

  const stats: DeltaStats = {
    totalNewBytes:  newBytes.length,
    copiedBytes:    0,
    literalBytes:   0,
    reusedBlocks:   0,
    newLiteralRuns: 0,
  };

  const ops: DeltaOp[] = [];
  for (const op of results) {
    if (op.type === "copy") {
      stats.copiedBytes  += op.length;
      stats.reusedBlocks += 1;
    } else {
      stats.literalBytes   += op.bytes.length;
      stats.newLiteralRuns += 1;
    }
    ops.push(op);
  }

  return { ops, stats, blockSize, mode };
}

export async function* computeDeltaChunked(
  newBytes: Uint8Array,
  oldSignatures: BlockSignature[],
  blockSize: number,
  mode: ChunkingMode = "cdc",
): AsyncGenerator<DeltaOp> {
  if (mode === "cdc") {
    yield* computeDeltaCdcChunked(newBytes, oldSignatures, blockSize);
    return;
  }

  const buckets = buildBucketsFixed(oldSignatures, blockSize);

  if (newBytes.length < blockSize) {
    if (newBytes.length > 0) {
      yield { type: "literal", offset: 0, bytes: newBytes.slice() };
    }
    return;
  }

  let i            = 0;
  let literalStart = 0;
  let state: Adler32State = adler32(newBytes, 0, blockSize);

  const yieldLiteral = function* (until: number): Generator<DeltaOp> {
    if (until > literalStart) {
      yield { type: "literal", offset: literalStart, bytes: newBytes.subarray(literalStart, until).slice() };
    }
  };

  while (i + blockSize <= newBytes.length) {
    const hash       = adler32Hash(state);
    const candidates = buckets.get(weak16(hash));
    let matched: BlockSignature | null = null;

    if (candidates) {
      const weakMatches = candidates.filter((c) => c.weak === hash);
      if (weakMatches.length) {
        const window = newBytes.subarray(i, i + blockSize);
        const strong = await sha256(window);
        matched = weakMatches.find((c) => c.strong === strong) ?? null;
      }
    }

    if (matched) {
      yield* yieldLiteral(i);
      yield { type: "copy", blockIndex: matched.index, offset: i, length: blockSize };
      i           += blockSize;
      literalStart = i;
      if (i + blockSize <= newBytes.length) {
        state = adler32(newBytes, i, i + blockSize);
      } else {
        break;
      }
    } else {
      const next = i + blockSize;
      if (next >= newBytes.length) { i += 1; break; }
      state = rollAdler32(state, newBytes[i], newBytes[next]);
      i += 1;
    }
  }

  yield* yieldLiteral(newBytes.length);
}

async function* computeDeltaCdcChunked(
  newBytes: Uint8Array,
  oldSignatures: BlockSignature[],
  blockSize: number,
): AsyncGenerator<DeltaOp> {
  if (!oldSignatures.length) {
    if (newBytes.length > 0) {
      yield { type: "literal", offset: 0, bytes: newBytes.slice() };
    }
    return;
  }

  const buckets = buildBucketsAll(oldSignatures);
  const ranges = cdcRanges(newBytes, {
    minSize: Math.max(256, Math.floor(blockSize / 4)),
    avgSize: blockSize,
    maxSize: Math.min(256 * 1024, blockSize * 32),
  });

  for (const { start, end } of ranges) {
    const slice = newBytes.subarray(start, end);
    const weak = adler32Hash(adler32(slice));
    const strong = await sha256(slice);
    const candidates = buckets.get(weak16(weak));
    const matched = candidates?.find(
      (c) => c.weak === weak && c.strong === strong && c.length === slice.length,
    );

    if (matched) {
      yield { type: "copy", blockIndex: matched.index, offset: start, length: slice.length };
    } else {
      yield { type: "literal", offset: start, bytes: slice.slice() };
    }
  }
}
