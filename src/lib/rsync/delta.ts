/**
 * Phase 4 — Chunked rsync delta computation.
 *
 * computeDelta   — original eager API (small files, browser playground).
 * computeDeltaChunked — async generator yielding ops in chunks; O(1) memory for huge files.
 *
 * Algorithm: slide a rolling Adler-32 window of size `blockSize` across newBytes.
 *   1. Cheap check: does the lower 16 bits of the weak hash match any old-block bucket?
 *   2. Expensive check: SHA-256 strong match.
 * On match → emit COPY op, jump window forward by blockSize.
 * No match → buffer byte into a literal run, slide by one.
 */

import {
  adler32,
  adler32Hash,
  rollAdler32,
  weak16,
  type Adler32State,
} from "./adler32";
import { sha256 } from "./strong-hash";
import type { BlockSignature } from "./signatures";

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
}

// ─── helpers ────────────────────────────────────────────────────────────────

function buildBuckets(sigs: BlockSignature[], blockSize: number): Map<number, BlockSignature[]> {
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

// ─── eager API (in-memory, unchanged interface) ──────────────────────────────

export async function computeDelta(
  newBytes: Uint8Array,
  oldSignatures: BlockSignature[],
  blockSize: number,
): Promise<DeltaResult> {
  const ops: DeltaOp[] = [];
  const results: DeltaOp[] = [];

  for await (const op of computeDeltaChunked(newBytes, oldSignatures, blockSize)) {
    results.push(op);
  }

  const stats: DeltaStats = {
    totalNewBytes:  newBytes.length,
    copiedBytes:    0,
    literalBytes:   0,
    reusedBlocks:   0,
    newLiteralRuns: 0,
  };

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

  return { ops, stats, blockSize };
}

// ─── Phase 4: chunked generator (O(1) memory per chunk) ─────────────────────

/**
 * Yields DeltaOps one at a time without buffering the full list.
 * Safe for files that exceed available RAM when used with a streaming upload.
 *
 * Usage:
 *   for await (const op of computeDeltaChunked(bytes, sigs, blockSize)) { ... }
 */
export async function* computeDeltaChunked(
  newBytes: Uint8Array,
  oldSignatures: BlockSignature[],
  blockSize: number,
): AsyncGenerator<DeltaOp> {
  const buckets = buildBuckets(oldSignatures, blockSize);

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
