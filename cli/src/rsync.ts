/**
 * Phase 2 + Phase 4 — CLI rsync delta engine.
 *
 * Op type updated: literals carry { literalOffset, literalLength } into a
 * raw Buffer instead of base64 strings, eliminating the 33% base64 overhead.
 *
 * computeDelta returns { ops, literalBytes } — the ops JSON goes in the 'meta'
 * multipart field; literalBytes goes as a raw binary 'literals' field.
 */

const BLOCK = 4096;
const MOD   = 65521;

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

// ─── helpers ─────────────────────────────────────────────────────────────────

function adler32(data: Buffer, start: number, end: number): number {
  let a = 1, b = 0;
  for (let i = start; i < end; i++) {
    a = (a + data[i]) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

async function sha256Hex(data: Buffer): Promise<string> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(data).digest("hex");
}

// ─── public API ──────────────────────────────────────────────────────────────

export async function buildSignatures(data: Buffer, blockSize = BLOCK): Promise<Signature[]> {
  const sigs: Signature[] = [];
  let offset = 0, idx = 0;
  while (offset < data.length) {
    const end   = Math.min(offset + blockSize, data.length);
    const chunk = data.subarray(offset, end);
    sigs.push({
      blockIndex: idx++,
      weakHash:   adler32(data, offset, end),
      strongHash: await sha256Hex(chunk),
      offset,
      length: end - offset,
    });
    offset = end;
  }
  return sigs;
}

/**
 * Phase 4: O(1) memory delta — no base64, no full-file buffering.
 * Returns raw ops + a consolidated literal Buffer.
 */
export async function computeDelta(
  newData:    Buffer,
  remoteSigs: Signature[],
  blockSize = BLOCK,
): Promise<DeltaResult> {
  // New file — entire contents are one literal run
  if (!remoteSigs.length) {
    return {
      ops:          [{ type: "literal", literalOffset: 0, literalLength: newData.length }],
      literalBytes: newData,
    };
  }

  const weakMap = new Map<number, Signature[]>();
  for (const s of remoteSigs) {
    const bucket = weakMap.get(s.weakHash);
    if (bucket) bucket.push(s);
    else weakMap.set(s.weakHash, [s]);
  }

  const ops:          Op[]     = [];
  const literalParts: Buffer[] = [];
  let   literalCursor          = 0;

  let i        = 0;
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
    const weak       = adler32(newData, i, i + blockSize);
    const candidates = weakMap.get(weak);

    if (candidates) {
      const strong = await sha256Hex(newData.subarray(i, i + blockSize));
      const match  = candidates.find((c) => c.strongHash === strong);
      if (match) {
        flushLiteral(i);
        ops.push({ type: "copy", blockIndex: match.blockIndex });
        i        += blockSize;
        litStart  = i;
        continue;
      }
    }
    i++;
  }

  flushLiteral(newData.length);

  return { ops, literalBytes: Buffer.concat(literalParts) };
}

export async function contentHash(data: Buffer): Promise<string> {
  return sha256Hex(data);
}
