import { describe, it, expect } from "vitest";
import {
  encodeChunkFrame,
  decodeFrameHeader,
  encodeAckFrame,
  encodeStreamEndFrame,
  FrameStreamParser,
  FrameType,
  FRAME_HEADER_SIZE,
} from "../shared/framed-stream";

describe("Binary Framing Protocol (DSO3)", () => {
  const hashHex = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const payloadData = Buffer.from("Hello DSO3 multiplexed streaming world!");

  it("encodes and decodes a chunk data frame header", () => {
    const frame = encodeChunkFrame(hashHex, payloadData);
    expect(frame.length).toBe(FRAME_HEADER_SIZE + payloadData.length);

    const header = decodeFrameHeader(frame);
    expect(header.type).toBe(FrameType.CHUNK_DATA);
    expect(header.length).toBe(payloadData.length);
    expect(header.hashHex).toBe(hashHex);
  });

  it("encodes ack and stream end frames", () => {
    const ack = encodeAckFrame(hashHex, 201);
    const ackHeader = decodeFrameHeader(ack);
    expect(ackHeader.type).toBe(FrameType.CHUNK_ACK);
    expect(ackHeader.length).toBe(2);

    const end = encodeStreamEndFrame();
    const endHeader = decodeFrameHeader(end);
    expect(endHeader.type).toBe(FrameType.STREAM_END);
    expect(endHeader.length).toBe(0);
  });

  it("reassembles fragmented chunk streams across byte boundaries", () => {
    const parser = new FrameStreamParser();
    const frame1 = encodeChunkFrame(hashHex, Buffer.from("Payload 1"));
    const frame2 = encodeChunkFrame(hashHex, Buffer.from("Payload 2 is slightly longer"));

    const combined = Buffer.concat([frame1, frame2]);

    // Feed in small 7-byte network slices to simulate TCP fragmentation
    const decodedFrames = [];
    const SLICE_SIZE = 7;
    for (let i = 0; i < combined.length; i += SLICE_SIZE) {
      const slice = combined.subarray(i, i + SLICE_SIZE);
      const frames = parser.push(slice);
      decodedFrames.push(...frames);
    }

    expect(decodedFrames).toHaveLength(2);
    expect(decodedFrames[0].payload.toString()).toBe("Payload 1");
    expect(decodedFrames[1].payload.toString()).toBe("Payload 2 is slightly longer");
    expect(parser.pendingBytes).toBe(0);
  });
});
