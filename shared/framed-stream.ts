/**
 * Binary Framing & Multiplexing Protocol (DSO3)
 *
 * Frame Format (Header = 40 Bytes):
 * [0..0]:   Frame Type (1 Byte)
 * [1..3]:   Reserved (3 Bytes)
 * [4..7]:   Payload Length (4 Bytes, Big Endian)
 * [8..39]:  SHA-256 Strong Hash (32 Bytes Raw Binary)
 * [40..N]:  Payload Data (N = 40 + Length)
 */

export enum FrameType {
  CHUNK_DATA = 0x01,
  CHUNK_ACK = 0x02,
  STREAM_END = 0x03,
  ERROR = 0xff,
}

export const FRAME_HEADER_SIZE = 40;

export interface DecodedFrame {
  type: FrameType;
  length: number;
  hashHex: string;
  payload: Buffer;
}

/**
 * Encodes a chunk data payload into a binary DSO3 frame.
 */
export function encodeChunkFrame(strongHashHex: string, payload: Uint8Array): Buffer {
  const hashBuf = Buffer.from(strongHashHex, "hex");
  if (hashBuf.length !== 32) {
    throw new Error(`Invalid strongHashHex length: expected 32 bytes, got ${hashBuf.length}`);
  }
  const frame = Buffer.allocUnsafe(FRAME_HEADER_SIZE + payload.length);

  frame.writeUInt8(FrameType.CHUNK_DATA, 0);
  frame.writeUIntBE(0, 1, 3); // Reserved 3 bytes
  frame.writeUInt32BE(payload.length, 4);
  hashBuf.copy(frame, 8, 0, 32);
  frame.set(payload, FRAME_HEADER_SIZE);

  return frame;
}

/**
 * Encodes an acknowledgement frame for a received chunk.
 */
export function encodeAckFrame(strongHashHex: string, statusCode = 200): Buffer {
  const hashBuf = Buffer.from(strongHashHex, "hex");
  const payload = Buffer.allocUnsafe(2);
  payload.writeUInt16BE(statusCode, 0);

  const frame = Buffer.allocUnsafe(FRAME_HEADER_SIZE + payload.length);
  frame.writeUInt8(FrameType.CHUNK_ACK, 0);
  frame.writeUIntBE(0, 1, 3);
  frame.writeUInt32BE(payload.length, 4);
  hashBuf.copy(frame, 8, 0, 32);
  frame.set(payload, FRAME_HEADER_SIZE);

  return frame;
}

/**
 * Encodes a terminal frame signalling stream completion.
 */
export function encodeStreamEndFrame(): Buffer {
  const frame = Buffer.alloc(FRAME_HEADER_SIZE, 0);
  frame.writeUInt8(FrameType.STREAM_END, 0);
  frame.writeUIntBE(0, 1, 3);
  frame.writeUInt32BE(0, 4);
  return frame;
}

/**
 * Decodes the 40-byte binary header from a buffer.
 */
export function decodeFrameHeader(headerBuf: Uint8Array): {
  type: FrameType;
  length: number;
  hashHex: string;
} {
  if (headerBuf.length < FRAME_HEADER_SIZE) {
    throw new Error(
      `Buffer too small for frame header: got ${headerBuf.length}, expected ${FRAME_HEADER_SIZE}`,
    );
  }
  const buf = Buffer.isBuffer(headerBuf) ? headerBuf : Buffer.from(headerBuf);
  const type = buf.readUInt8(0) as FrameType;
  const length = buf.readUInt32BE(4);
  const hashHex = buf.subarray(8, 40).toString("hex");

  return { type, length, hashHex };
}

/**
 * Streaming parser that consumes arbitrary fragmented TCP/HTTP chunk streams
 * and reassembles complete DSO3 frames.
 */
export class FrameStreamParser {
  private buffer: Buffer = Buffer.alloc(0);

  public push(chunk: Uint8Array): DecodedFrame[] {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, incoming]);

    const frames: DecodedFrame[] = [];

    while (this.buffer.length >= FRAME_HEADER_SIZE) {
      const header = decodeFrameHeader(this.buffer.subarray(0, FRAME_HEADER_SIZE));
      const totalFrameSize = FRAME_HEADER_SIZE + header.length;

      if (this.buffer.length < totalFrameSize) {
        // Incomplete payload, wait for next network chunk
        break;
      }

      const payload = this.buffer.subarray(FRAME_HEADER_SIZE, totalFrameSize);
      frames.push({
        type: header.type,
        length: header.length,
        hashHex: header.hashHex,
        payload: Buffer.from(payload), // detach slice copy
      });

      this.buffer = this.buffer.subarray(totalFrameSize);
    }

    return frames;
  }

  public get pendingBytes(): number {
    return this.buffer.length;
  }

  public reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}
