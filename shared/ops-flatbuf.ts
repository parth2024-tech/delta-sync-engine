/**
 * FlatBuffer-style zero-copy operation manifest codec (v2).
 *
 * Unlike JSON (which allocates a full object graph) or the custom DSO1 binary
 * format (which copies into an UploadOp[] array), this codec allows reading
 * operation data DIRECTLY from the binary buffer without unpacking.
 *
 * Layout v2 (little-endian):
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ Header (fixed 80 bytes)                                         │
 *   ├─────────────────┬──────────────────────────────────────────────┤
 *   │ magic           │ "DSO2" (4 bytes)                             │
 *   │ version         │ uint8 (1 byte) — currently 2                 │
 *   │ flags           │ uint8 (1 byte) — reserved                    │
 *   │ padding         │ 2 bytes                                      │
 *   │ opCount         │ uint32 (4 bytes)                              │
 *   │ blockSize       │ uint32 (4 bytes)                              │
 *   │ contentSha256   │ 32 bytes (raw binary SHA-256)                 │
 *   │ newSize         │ uint32 (4 bytes)                              │
 *   │ reserved        │ 28 bytes (future fields)                      │
 *   ├─────────────────┴──────────────────────────────────────────────┤
 *   │ Op Table (opCount × 9 bytes each)                               │
 *   ├────────────────────────────────────────────────────────────────┤
 *   │ kind            │ uint8 — 0=copy, 1=literal                    │
 *   │ a               │ uint32 — blockIndex (copy) or offset (lit)   │
 *   │ b               │ uint32 — 0 (copy) or length (literal)        │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * Total size: 80 + (opCount × 9) bytes
 *
 * Zero-copy access: call `reader.opType(i)` and `reader.opBlockIndex(i)`
 * to read fields directly from the buffer at computed offsets — no
 * intermediate object allocation.
 */

const MAGIC = Buffer.from("DSO2");
const HEADER_SIZE = 80;
const OP_ROW_SIZE = 9; // 1 + 4 + 4
const VERSION = 2;

const OP_COPY = 0;
const OP_LITERAL = 1;

// ── Encoder ───────────────────────────────────────────────────────────────────

export interface FlatOp {
  type: "copy" | "literal";
  blockIndex?: number;
  literalOffset?: number;
  literalLength?: number;
}

export interface FlatManifestInput {
  blockSize: number;
  contentSha256: string; // 64-char hex string
  newSize: number;
  ops: FlatOp[];
}

/**
 * Encode an operation manifest into the v2 FlatBuffer format.
 * Returns a single contiguous Buffer ready for wire transmission.
 */
export function encodeFlatManifest(input: FlatManifestInput): Buffer {
  const opCount = input.ops.length;
  const totalSize = HEADER_SIZE + opCount * OP_ROW_SIZE;
  const buf = Buffer.alloc(totalSize); // zero-filled

  // Header
  MAGIC.copy(buf, 0);
  buf.writeUInt8(VERSION, 4);
  buf.writeUInt8(0, 5); // flags
  // bytes 6-7: padding
  buf.writeUInt32LE(opCount, 8);
  buf.writeUInt32LE(input.blockSize, 12);

  // SHA-256 as raw binary (32 bytes)
  const sha256Buf = Buffer.from(input.contentSha256, "hex");
  if (sha256Buf.length === 32) {
    sha256Buf.copy(buf, 16);
  }

  buf.writeUInt32LE(input.newSize, 48);
  // bytes 52-79: reserved

  // Op Table
  let p = HEADER_SIZE;
  for (const op of input.ops) {
    if (op.type === "copy") {
      buf.writeUInt8(OP_COPY, p);
      buf.writeUInt32LE(op.blockIndex ?? 0, p + 1);
      buf.writeUInt32LE(0, p + 5);
    } else {
      buf.writeUInt8(OP_LITERAL, p);
      buf.writeUInt32LE(op.literalOffset ?? 0, p + 1);
      buf.writeUInt32LE(op.literalLength ?? 0, p + 5);
    }
    p += OP_ROW_SIZE;
  }

  return buf;
}

// ── Zero-Copy Reader ──────────────────────────────────────────────────────────

/**
 * Zero-copy FlatBuffer manifest reader.
 *
 * Reads operation data directly from the buffer at computed byte offsets.
 * No intermediate arrays or objects are allocated — ideal for handling
 * manifests with millions of operations.
 *
 * Usage:
 *   const reader = new FlatManifestReader(buffer);
 *   for (let i = 0; i < reader.opCount; i++) {
 *     if (reader.opType(i) === 0) {
 *       console.log("Copy block", reader.opA(i));
 *     } else {
 *       console.log("Literal at offset", reader.opA(i), "length", reader.opB(i));
 *     }
 *   }
 */
export class FlatManifestReader {
  private buf: Buffer;

  constructor(data: Buffer | Uint8Array) {
    this.buf = data instanceof Buffer ? data : Buffer.from(data);
    this.validate();
  }

  private validate(): void {
    if (this.buf.length < HEADER_SIZE) {
      throw new Error(`FlatManifest too short: ${this.buf.length} bytes (need >= ${HEADER_SIZE})`);
    }
    if (this.buf.subarray(0, 4).toString() !== "DSO2") {
      throw new Error("Invalid FlatManifest magic (expected DSO2)");
    }
    const ver = this.buf.readUInt8(4);
    if (ver !== VERSION) {
      throw new Error(`Unsupported FlatManifest version: ${ver}`);
    }
    const expectedSize = HEADER_SIZE + this.opCount * OP_ROW_SIZE;
    if (this.buf.length < expectedSize) {
      throw new Error(`Truncated FlatManifest: have ${this.buf.length} bytes, need ${expectedSize}`);
    }
  }

  /** Number of operations in this manifest. */
  get opCount(): number {
    return this.buf.readUInt32LE(8);
  }

  /** Block size used for chunking. */
  get blockSize(): number {
    return this.buf.readUInt32LE(12);
  }

  /** Content SHA-256 as hex string. */
  get contentSha256(): string {
    return this.buf.subarray(16, 48).toString("hex");
  }

  /** Expected total file size after reconstruction. */
  get newSize(): number {
    return this.buf.readUInt32LE(48);
  }

  // ── Per-operation accessors (zero-copy, no allocation) ────────────────────

  private opOffset(i: number): number {
    return HEADER_SIZE + i * OP_ROW_SIZE;
  }

  /** Operation kind at index i: 0 = copy, 1 = literal. */
  opType(i: number): number {
    return this.buf.readUInt8(this.opOffset(i));
  }

  /** Is this a copy operation? */
  isCopy(i: number): boolean {
    return this.opType(i) === OP_COPY;
  }

  /** Field A: blockIndex (copy) or literalOffset (literal). */
  opA(i: number): number {
    return this.buf.readUInt32LE(this.opOffset(i) + 1);
  }

  /** Field B: 0 (copy) or literalLength (literal). */
  opB(i: number): number {
    return this.buf.readUInt32LE(this.opOffset(i) + 5);
  }

  // ── Convenience: convert to the legacy UploadOp[] format ─────────────────

  /** Convert to the legacy UploadOp array format (allocates). */
  toUploadOps(): Array<
    | { type: "copy"; blockIndex: number }
    | { type: "literal"; literalOffset: number; literalLength: number }
  > {
    const ops = [];
    for (let i = 0; i < this.opCount; i++) {
      if (this.isCopy(i)) {
        ops.push({ type: "copy" as const, blockIndex: this.opA(i) });
      } else {
        ops.push({
          type: "literal" as const,
          literalOffset: this.opA(i),
          literalLength: this.opB(i),
        });
      }
    }
    return ops;
  }

  /** Total wire size of this manifest in bytes. */
  get totalBytes(): number {
    return HEADER_SIZE + this.opCount * OP_ROW_SIZE;
  }
}

// ── Compatibility: decode DSO1 or DSO2 ────────────────────────────────────────

import { decodeOpsBinaryV1, type UploadOp } from "./ops-binary";

/**
 * Universal decoder: accepts both DSO1 (legacy) and DSO2 (FlatBuffer) formats.
 * Returns a zero-copy reader for DSO2, or materializes an UploadOp[] for DSO1.
 */
export function decodeOpsUniversal(buf: Buffer): {
  format: "dso1" | "dso2";
  ops: UploadOp[];
  reader?: FlatManifestReader;
} {
  const magic = buf.subarray(0, 4).toString();
  if (magic === "DSO2") {
    const reader = new FlatManifestReader(buf);
    return { format: "dso2", ops: reader.toUploadOps(), reader };
  }
  if (magic === "DSO1") {
    return { format: "dso1", ops: decodeOpsBinaryV1(buf) };
  }
  throw new Error(`Unknown ops format magic: ${magic}`);
}
