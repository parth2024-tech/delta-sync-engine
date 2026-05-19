/**
 * Tests for the streaming chunk manifest decoder.
 */
import { describe, it, expect } from "vitest";
import {
  encodeChunkManifestV1,
  decodeChunkManifestV1,
  decodeChunkManifestV1Streaming,
  iterateManifestHashPages,
} from "../shared/chunk-manifest";

describe("Streaming Chunk Manifest Decoder", () => {
  const makeChunks = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      offset: i * 4096,
      length: 4096,
      weakHash: i,
      strongHashHex: i.toString(16).padStart(64, "0"),
    }));

  it("produces identical results to batch decoder", () => {
    const chunks = makeChunks(50);
    const encoded = encodeChunkManifestV1(chunks);

    const batchResult = decodeChunkManifestV1(encoded);
    const streamResult: typeof batchResult = [];
    decodeChunkManifestV1Streaming(encoded, (chunk) => streamResult.push(chunk));

    expect(streamResult.length).toBe(batchResult.length);
    for (let i = 0; i < batchResult.length; i++) {
      expect(streamResult[i]).toEqual(batchResult[i]);
    }
  });

  it("returns the correct count", () => {
    const encoded = encodeChunkManifestV1(makeChunks(25));
    const count = decodeChunkManifestV1Streaming(encoded, () => {});
    expect(count).toBe(25);
  });

  it("handles empty manifest", () => {
    const encoded = encodeChunkManifestV1([]);
    const items: unknown[] = [];
    const count = decodeChunkManifestV1Streaming(encoded, (c) => items.push(c));
    expect(count).toBe(0);
    expect(items).toEqual([]);
  });

  it("throws on invalid magic bytes", () => {
    const badBuf = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(() => decodeChunkManifestV1Streaming(badBuf, () => {})).toThrow("Invalid chunk manifest magic");
  });
});

describe("Manifest Hash Page Iterator", () => {
  const makeChunksWithDups = () => {
    const hash1 = "a".repeat(64);
    const hash2 = "b".repeat(64);
    const hash3 = "c".repeat(64);
    // 5 chunks but only 3 unique hashes
    return [
      { offset: 0, length: 4096, weakHash: 1, strongHashHex: hash1 },
      { offset: 4096, length: 4096, weakHash: 2, strongHashHex: hash2 },
      { offset: 8192, length: 4096, weakHash: 3, strongHashHex: hash1 }, // dup
      { offset: 12288, length: 4096, weakHash: 4, strongHashHex: hash3 },
      { offset: 16384, length: 4096, weakHash: 5, strongHashHex: hash2 }, // dup
    ];
  };

  it("yields only unique hashes", () => {
    const encoded = encodeChunkManifestV1(makeChunksWithDups());
    const allHashes: string[] = [];
    for (const page of iterateManifestHashPages(encoded, 100)) {
      allHashes.push(...page);
    }
    expect(allHashes.length).toBe(3);
    expect(new Set(allHashes).size).toBe(3);
  });

  it("respects page size", () => {
    // Create 25 unique chunks
    const chunks = Array.from({ length: 25 }, (_, i) => ({
      offset: i * 4096,
      length: 4096,
      weakHash: i,
      strongHashHex: i.toString(16).padStart(64, "0"),
    }));
    const encoded = encodeChunkManifestV1(chunks);

    const pages: string[][] = [];
    for (const page of iterateManifestHashPages(encoded, 10)) {
      pages.push(page);
    }

    expect(pages.length).toBe(3); // 10 + 10 + 5
    expect(pages[0]!.length).toBe(10);
    expect(pages[1]!.length).toBe(10);
    expect(pages[2]!.length).toBe(5);
  });

  it("yields empty for empty manifest", () => {
    const encoded = encodeChunkManifestV1([]);
    const pages: string[][] = [];
    for (const page of iterateManifestHashPages(encoded, 10)) {
      pages.push(page);
    }
    expect(pages.length).toBe(0);
  });
});
