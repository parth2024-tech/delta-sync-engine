/**
 * Content-defined chunking: rolling polynomial fingerprint.
 * Cut when fingerprint matches mask (expected chunk size ~avgSize, power-of-two mask).
 */

export interface CdcOptions {
  minSize: number;
  avgSize: number;
  maxSize: number;
}

function maskBits(avg: number): number {
  const p2 = 2 ** Math.floor(Math.log2(Math.max(64, avg)));
  return p2 - 1;
}

/** Exclusive end offsets for chunks covering data. */
export function cdcChunkEnds(data: Uint8Array, opts: CdcOptions): number[] {
  const { minSize, maxSize } = opts;
  const mask = maskBits(opts.avgSize);
  const ends: number[] = [];
  let n = 0;
  const len = data.length;

  while (n < len) {
    const hardMax = Math.min(n + maxSize, len);
    const minEnd = Math.min(n + minSize, len);
    let fp = 0x811c9dc5; // FNV-1a-ish seed
    let i = n;
    while (i < minEnd) {
      fp = (Math.imul(fp, 0x01000193) ^ data[i]!) >>> 0;
      i++;
    }
    let cut = hardMax;
    while (i < hardMax) {
      fp = (Math.imul(fp, 0x01000193) ^ data[i]!) >>> 0;
      i++;
      if ((fp & mask) === 0) {
        cut = i;
        break;
      }
    }
    if (cut <= n) cut = Math.min(n + 1, len);
    ends.push(cut);
    n = cut;
  }
  return ends;
}

export function cdcRanges(data: Uint8Array, opts: CdcOptions): { start: number; end: number }[] {
  const ends = cdcChunkEnds(data, opts);
  const ranges: { start: number; end: number }[] = [];
  let prev = 0;
  for (const end of ends) {
    ranges.push({ start: prev, end });
    prev = end;
  }
  return ranges;
}
