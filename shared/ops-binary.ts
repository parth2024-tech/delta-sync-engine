/**
 * Compact wire format for upload ops (avoids multi-megabyte JSON arrays).
 *
 * Layout v1 (little-endian):
 *   magic "DSO1" (4 bytes)
 *   uint32 opCount
 *   opCount × op:
 *     uint8 kind — 0 = copy, 1 = literal
 *     copy:    uint32 blockIndex
 *     literal: uint32 literalOffset, uint32 literalLength
 */

import { z } from "zod";

export const OPS_BIN_MAGIC = Buffer.from("DSO1");

export type OpCopy = { type: "copy"; blockIndex: number };
export type OpLiteral = { type: "literal"; literalOffset: number; literalLength: number };
export type UploadOp = OpCopy | OpLiteral;

const OP_COPY = 0;
const OP_LITERAL = 1;

export function encodeOpsBinaryV1(ops: UploadOp[]): Buffer {
  const header = 8;
  let body = 0;
  for (const op of ops) {
    body += op.type === "copy" ? 1 + 4 : 1 + 4 + 4;
  }
  const buf = Buffer.allocUnsafe(header + body);
  OPS_BIN_MAGIC.copy(buf, 0);
  buf.writeUInt32LE(ops.length, 4);
  let p = 8;
  for (const op of ops) {
    if (op.type === "copy") {
      buf.writeUInt8(OP_COPY, p++);
      buf.writeUInt32LE(op.blockIndex >>> 0, p);
      p += 4;
    } else {
      buf.writeUInt8(OP_LITERAL, p++);
      buf.writeUInt32LE(op.literalOffset >>> 0, p);
      p += 4;
      buf.writeUInt32LE(op.literalLength >>> 0, p);
      p += 4;
    }
  }
  return buf;
}

export function decodeOpsBinaryV1(buf: Buffer): UploadOp[] {
  if (buf.length < 8 || buf.subarray(0, 4).toString() !== "DSO1") {
    throw new Error("Invalid ops binary magic");
  }
  const count = buf.readUInt32LE(4);
  const ops: UploadOp[] = [];
  let p = 8;
  for (let i = 0; i < count; i++) {
    if (p >= buf.length) throw new Error("Truncated ops binary");
    const kind = buf.readUInt8(p++);
    if (kind === OP_COPY) {
      if (p + 4 > buf.length) throw new Error("Truncated copy op");
      ops.push({ type: "copy", blockIndex: buf.readUInt32LE(p) });
      p += 4;
    } else if (kind === OP_LITERAL) {
      if (p + 8 > buf.length) throw new Error("Truncated literal op");
      ops.push({
        type:           "literal",
        literalOffset:  buf.readUInt32LE(p),
        literalLength:  buf.readUInt32LE(p + 4),
      });
      p += 8;
    } else {
      throw new Error(`Unknown op kind ${kind}`);
    }
  }
  if (p !== buf.length) throw new Error("Trailing data in ops binary");
  return ops;
}

/** Zod shape matches JSON ops (for mixed validation). */
export const opSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("copy"), blockIndex: z.number().int().min(0) }),
  z.object({ type: z.literal("literal"), literalOffset: z.number().int().min(0), literalLength: z.number().int().min(1) }),
]);
