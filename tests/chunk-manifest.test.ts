/**
 * Tests for chunk manifest encoding/decoding.
 */
import { describe, it, expect } from "vitest";
import { encodeChunkManifestV1, decodeChunkManifestV1 } from "../shared/chunk-manifest";

describe("Chunk Manifest Codec", () => {
  it("round-trips a manifest with multiple chunks", () => {
    const chunks = [
      { offset: 0,     length: 4096, weakHash: 0x12345678, strongHashHex: "a".repeat(64) },
      { offset: 4096,  length: 4096, weakHash: 0xdeadbeef, strongHashHex: "b".repeat(64) },
      { offset: 8192,  length: 2048, weakHash: 0x00000001, strongHashHex: "c".repeat(64) },
    ];

    const encoded = encodeChunkManifestV1(chunks);
    const decoded = decodeChunkManifestV1(encoded);

    expect(decoded.length).toBe(3);
    for (let i = 0; i < chunks.length; i++) {
      expect(decoded[i]!.offset).toBe(chunks[i]!.offset);
      expect(decoded[i]!.length).toBe(chunks[i]!.length);
      expect(decoded[i]!.weakHash).toBe(chunks[i]!.weakHash);
      expect(decoded[i]!.strongHashHex).toBe(chunks[i]!.strongHashHex);
      expect(decoded[i]!.blockIndex).toBe(i);
    }
  });

  it("handles empty manifest", () => {
    const encoded = encodeChunkManifestV1([]);
    const decoded = decodeChunkManifestV1(encoded);
    expect(decoded).toEqual([]);
  });

  it("handles single chunk", () => {
    const chunks = [
      { offset: 0, length: 1024, weakHash: 42, strongHashHex: "0123456789abcdef".repeat(4) },
    ];
    const encoded = encodeChunkManifestV1(chunks);
    const decoded = decodeChunkManifestV1(encoded);
    expect(decoded.length).toBe(1);
    expect(decoded[0]!.strongHashHex).toBe("0123456789abcdef".repeat(4));
  });

  it("throws on invalid magic bytes", () => {
    const badBuf = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(() => decodeChunkManifestV1(badBuf)).toThrow("Invalid chunk manifest magic");
  });

  it("throws on truncated manifest", () => {
    const chunks = [
      { offset: 0, length: 1024, weakHash: 42, strongHashHex: "a".repeat(64) },
    ];
    const encoded = encodeChunkManifestV1(chunks);
    // Truncate the buffer
    const truncated = encoded.subarray(0, 20);
    expect(() => decodeChunkManifestV1(truncated)).toThrow("Truncated chunk manifest");
  });

  it("preserves exact hash values through round-trip", () => {
    const realHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const chunks = [
      { offset: 0, length: 0, weakHash: 0, strongHashHex: realHash },
    ];
    const decoded = decodeChunkManifestV1(encodeChunkManifestV1(chunks));
    expect(decoded[0]!.strongHashHex).toBe(realHash);
  });
});
