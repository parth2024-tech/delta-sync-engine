// Minimal rsync delta engine for the CLI (no native deps)
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
  | { type: "literal"; bytesB64: string   };

function adler32(data: Buffer, start: number, end: number): number {
  let a = 1, b = 0;
  for (let i = start; i < end; i++) { a = (a + data[i]) % MOD; b = (b + a) % MOD; }
  return (b << 16) | a;
}

async function sha256Hex(data: Buffer | string): Promise<string> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "base64") : data).digest("hex");
}

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
      length:     end - offset,
    });
    offset = end;
  }
  return sigs;
}

export async function computeDelta(newData: Buffer, remoteSigs: Signature[], blockSize = BLOCK): Promise<Op[]> {
  if (!remoteSigs.length) {
    const b64 = newData.toString("base64");
    return [{ type: "literal", bytesB64: b64 }];
  }

  const weakMap  = new Map<number, Signature[]>();
  for (const s of remoteSigs) {
    if (!weakMap.has(s.weakHash)) weakMap.set(s.weakHash, []);
    weakMap.get(s.weakHash)!.push(s);
  }

  const ops: Op[] = [];
  let i = 0;
  let litStart = 0;

  while (i <= newData.length - blockSize) {
    const weak = adler32(newData, i, i + blockSize);
    const candidates = weakMap.get(weak);
    if (candidates) {
      const strong = await sha256Hex(newData.subarray(i, i + blockSize));
      const match  = candidates.find((c) => c.strongHash === strong);
      if (match) {
        if (litStart < i) {
          ops.push({ type: "literal", bytesB64: newData.subarray(litStart, i).toString("base64") });
        }
        ops.push({ type: "copy", blockIndex: match.blockIndex });
        i       += blockSize;
        litStart = i;
        continue;
      }
    }
    i++;
  }

  if (litStart < newData.length) {
    ops.push({ type: "literal", bytesB64: newData.subarray(litStart).toString("base64") });
  }

  return ops;
}

export async function contentHash(data: Buffer): Promise<string> {
  return sha256Hex(data);
}
