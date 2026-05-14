// The rsync delta algorithm.
//
// Given old block signatures + new file bytes, slide a rolling Adler-32 window
// of size `blockSize` across the new file. On each position:
//   1. Cheap check: does the weak hash match any old block? (16-bit bucket lookup)
//   2. Expensive check: does the strong SHA-256 of the window match? (collision-proof)
// On a confirmed match, emit a COPY op pointing at the matched old block,
// flush any buffered literals, and jump the window forward by `blockSize`.
// Otherwise, push the leftmost byte into a literal run and slide by one.

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
  | { type: "copy"; blockIndex: number; offset: number; length: number }
  | { type: "literal"; offset: number; bytes: Uint8Array };

export interface DeltaStats {
  totalNewBytes: number;
  copiedBytes: number;
  literalBytes: number;
  reusedBlocks: number;
  newLiteralRuns: number;
}

export interface DeltaResult {
  ops: DeltaOp[];
  stats: DeltaStats;
  blockSize: number;
}

export async function computeDelta(
  newBytes: Uint8Array,
  oldSignatures: BlockSignature[],
  blockSize: number,
): Promise<DeltaResult> {
  // Build the two-level lookup: weak16 -> [signatures with that bucket].
  const buckets = new Map<number, BlockSignature[]>();
  for (const sig of oldSignatures) {
    if (sig.length !== blockSize) continue; // ignore final short block for matching
    const key = weak16(sig.weak);
    const list = buckets.get(key);
    if (list) list.push(sig);
    else buckets.set(key, [sig]);
  }

  const ops: DeltaOp[] = [];
  const stats: DeltaStats = {
    totalNewBytes: newBytes.length,
    copiedBytes: 0,
    literalBytes: 0,
    reusedBlocks: 0,
    newLiteralRuns: 0,
  };

  if (newBytes.length < blockSize) {
    // Smaller than one block — emit as a single literal.
    if (newBytes.length > 0) {
      ops.push({ type: "literal", offset: 0, bytes: newBytes.slice() });
      stats.literalBytes = newBytes.length;
      stats.newLiteralRuns = 1;
    }
    return { ops, stats, blockSize };
  }

  let i = 0;
  let literalStart = 0;
  let state: Adler32State = adler32(newBytes, 0, blockSize);

  const flushLiteral = (until: number) => {
    if (until > literalStart) {
      const slice = newBytes.subarray(literalStart, until).slice();
      ops.push({ type: "literal", offset: literalStart, bytes: slice });
      stats.literalBytes += slice.length;
      stats.newLiteralRuns += 1;
    }
  };

  while (i + blockSize <= newBytes.length) {
    const hash = adler32Hash(state);
    const candidates = buckets.get(weak16(hash));
    let matched: BlockSignature | null = null;

    if (candidates) {
      const window = newBytes.subarray(i, i + blockSize);
      // Verify with full Adler-32 first (cheaper than SHA), then SHA.
      const weakMatches = candidates.filter((c) => c.weak === hash);
      if (weakMatches.length) {
        const strong = await sha256(window);
        matched = weakMatches.find((c) => c.strong === strong) ?? null;
      }
    }

    if (matched) {
      flushLiteral(i);
      ops.push({
        type: "copy",
        blockIndex: matched.index,
        offset: i,
        length: blockSize,
      });
      stats.copiedBytes += blockSize;
      stats.reusedBlocks += 1;
      i += blockSize;
      literalStart = i;
      if (i + blockSize <= newBytes.length) {
        state = adler32(newBytes, i, i + blockSize);
      } else {
        break;
      }
    } else {
      // Slide window by one byte.
      const next = i + blockSize;
      if (next >= newBytes.length) {
        i += 1;
        break;
      }
      state = rollAdler32(state, newBytes[i], newBytes[next]);
      i += 1;
    }
  }

  // Anything past the last matched block is a trailing literal.
  flushLiteral(newBytes.length);

  return { ops, stats, blockSize };
}
