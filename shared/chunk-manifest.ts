/**
 * Packed chunk manifest — one blob per file version instead of one DB row per chunk.
 *
 * Layout v1 (little-endian):
 *   magic "DSM1" (4)
 *   uint32 chunkCount
 *   chunkCount × (uint32 offset, uint32 length, uint32 weakHash, 32 bytes sha256 binary)
 */

import { adler32 } from "./hash";

export const MANIFEST_MAGIC = new Uint8Array([0x44, 0x53, 0x4d, 0x31]); // DSM1

export interface ManifestChunk {
  blockIndex: number;
  offset: number;
  length: number;
  weakHash: number;
  strongHashHex: string;
}

function hex32(buf: Uint8Array, off: number): string {
  let s = "";
  for (let i = 0; i < 32; i++) {
    s += buf[off + i]!.toString(16).padStart(2, "0");
  }
  return s;
}

export function encodeChunkManifestV1(chunks: Omit<ManifestChunk, "blockIndex">[]): Buffer {
  const count = chunks.length;
  const row = 4 + 4 + 4 + 4 + 32; // offset, len, weak, strong
  const buf = Buffer.allocUnsafe(8 + count * row);
  buf.set(MANIFEST_MAGIC, 0);
  buf.writeUInt32LE(count, 4);
  let p = 8;
  for (let i = 0; i < count; i++) {
    const c = chunks[i]!;
    buf.writeUInt32LE(c.offset >>> 0, p);
    p += 4;
    buf.writeUInt32LE(c.length >>> 0, p);
    p += 4;
    buf.writeUInt32LE(c.weakHash >>> 0, p);
    p += 4;
    buf.write(c.strongHashHex, p, 32, "hex");
    p += 32;
  }
  return buf;
}

export function decodeChunkManifestV1(buf: Buffer | Uint8Array): ManifestChunk[] {
  const u = buf instanceof Buffer ? buf : Buffer.from(buf);
  if (u.length < 8 || u[0] !== 0x44 || u[1] !== 0x53 || u[2] !== 0x4d || u[3] !== 0x31) {
    throw new Error("Invalid chunk manifest magic");
  }
  const count = u.readUInt32LE(4);
  const row = 44;
  if (u.length < 8 + count * row) throw new Error("Truncated chunk manifest");
  const out: ManifestChunk[] = [];
  let p = 8;
  for (let i = 0; i < count; i++) {
    const offset = u.readUInt32LE(p);
    p += 4;
    const length = u.readUInt32LE(p);
    p += 4;
    const weakHash = u.readUInt32LE(p);
    p += 4;
    const strongHex = hex32(u, p);
    p += 32;
    out.push({ blockIndex: i, offset, length, weakHash, strongHashHex: strongHex });
  }
  return out;
}

/** Weak hash for a chunk (Adler-32, same as rsync-style signatures). */
export function weakHashChunk(slice: Uint8Array): number {
  return adler32(slice);
}
