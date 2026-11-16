import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  adaptiveChunkSize,
  SMALL_FILE_THRESHOLD,
  contentHash,
  contentHashFile,
  readChunkSlice,
  buildSignatures,
  buildSignaturesFromFile,
  computeDelta,
} from "../cli/src/rsync.js";
import { sha256Hex, adler32 } from "../shared/hash.js";

describe("CLI Rsync & CDC Engine", () => {
  describe("adaptiveChunkSize", () => {
    it("returns 0 for files below SMALL_FILE_THRESHOLD (32 KB)", () => {
      expect(adaptiveChunkSize(0)).toBe(0);
      expect(adaptiveChunkSize(1024)).toBe(0);
      expect(adaptiveChunkSize(SMALL_FILE_THRESHOLD - 1)).toBe(0);
    });

    it("returns 4096 (4 KiB) for files between 32 KB and 256 KB", () => {
      expect(adaptiveChunkSize(SMALL_FILE_THRESHOLD)).toBe(4096);
      expect(adaptiveChunkSize(64 * 1024)).toBe(4096);
      expect(adaptiveChunkSize(256 * 1024 - 1)).toBe(4096);
    });

    it("returns 16384 (16 KiB) for files between 256 KB and 10 MB", () => {
      expect(adaptiveChunkSize(256 * 1024)).toBe(16384);
      expect(adaptiveChunkSize(1024 * 1024)).toBe(16384);
      expect(adaptiveChunkSize(10 * 1024 * 1024 - 1)).toBe(16384);
    });

    it("returns 65536 (64 KiB) for files >= 10 MB", () => {
      expect(adaptiveChunkSize(10 * 1024 * 1024)).toBe(65536);
      expect(adaptiveChunkSize(50 * 1024 * 1024)).toBe(65536);
    });
  });

  describe("contentHash", () => {
    it("computes accurate SHA-256 hex digest for arbitrary buffers", async () => {
      const data = Buffer.from("DeltaSync distributed file sync test payload");
      const expected = await sha256Hex(data);
      const hash = await contentHash(data);
      expect(hash).toBe(expected);
      expect(hash).toHaveLength(64);
    });
  });

  describe("buildSignatures", () => {
    it("splits data into fixed blocks for fixed chunking", async () => {
      const data = Buffer.alloc(1000, "a");
      const blockSize = 256;
      const sigs = await buildSignatures(data, { chunking: "fixed", blockSize });

      // 1000 / 256 = 3 full blocks (256 each) + 1 partial block (232 bytes)
      expect(sigs).toHaveLength(4);
      expect(sigs[0]!.blockIndex).toBe(0);
      expect(sigs[0]!.offset).toBe(0);
      expect(sigs[0]!.length).toBe(256);
      expect(sigs[3]!.blockIndex).toBe(3);
      expect(sigs[3]!.offset).toBe(768);
      expect(sigs[3]!.length).toBe(232);

      // Verify hashes
      const block0 = data.subarray(0, 256);
      expect(sigs[0]!.weakHash).toBe(adler32(block0));
      expect(sigs[0]!.strongHash).toBe(await sha256Hex(block0));
    });

    it("builds contiguous content-defined chunks for CDC chunking", async () => {
      // 300KB of diverse data to trigger probabilistic CDC mask cuts
      const data = Buffer.alloc(300 * 1024);
      let seed = 42;
      for (let i = 0; i < data.length; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        data[i] = seed & 0xff;
      }

      const sigs = await buildSignatures(data, { chunking: "cdc", blockSize: 2048 });
      expect(sigs.length).toBeGreaterThan(1);

      // Verify contiguous coverage
      let currentOffset = 0;
      for (let i = 0; i < sigs.length; i++) {
        const sig = sigs[i]!;
        expect(sig.blockIndex).toBe(i);
        expect(sig.offset).toBe(currentOffset);
        expect(sig.length).toBeGreaterThan(0);
        currentOffset += sig.length;
      }
      expect(currentOffset).toBe(data.length);
    });
  });

  describe("computeDelta", () => {
    it("emits single literal op if remote signatures are empty", async () => {
      const data = Buffer.from("brand new file without remote baseline");
      const delta = await computeDelta(data, [], { chunking: "fixed", blockSize: 128 });

      expect(delta.ops).toHaveLength(1);
      expect(delta.ops[0]).toEqual({
        type: "literal",
        literalOffset: 0,
        literalLength: data.length,
      });
      expect(delta.literalBytes.toString()).toBe(data.toString());
    });

    it("emits copy operations when fixed-size blocks match exactly", async () => {
      // Use distinct bytes per block so hashes are distinct
      const data = Buffer.concat([Buffer.alloc(256, 1), Buffer.alloc(256, 2)]);
      const sigs = await buildSignatures(data, { chunking: "fixed", blockSize: 256 });
      const delta = await computeDelta(data, sigs, { chunking: "fixed", blockSize: 256 });

      expect(delta.ops).toEqual([
        { type: "copy", blockIndex: 0 },
        { type: "copy", blockIndex: 1 },
      ]);
      expect(delta.literalBytes).toHaveLength(0);
    });

    it("emits copy and literal operations when middle bytes change in fixed mode", async () => {
      const original = Buffer.concat([
        Buffer.alloc(256, 1),
        Buffer.alloc(256, 2),
        Buffer.alloc(256, 3),
        Buffer.alloc(256, 4),
      ]);
      const sigs = await buildSignatures(original, { chunking: "fixed", blockSize: 256 });

      // Mutate the second block (offset 256..512)
      const modified = Buffer.from(original);
      modified.write("MUTATED_DATA", 260);

      const delta = await computeDelta(modified, sigs, { chunking: "fixed", blockSize: 256 });

      // Block 0 matches
      expect(delta.ops[0]).toEqual({ type: "copy", blockIndex: 0 });
      // Mutated area produces literal ops
      const copyOps = delta.ops.filter((op) => op.type === "copy");
      const literalOps = delta.ops.filter((op) => op.type === "literal");
      expect(copyOps.length).toBeGreaterThanOrEqual(2);
      expect(literalOps.length).toBeGreaterThanOrEqual(1);
      expect(delta.literalBytes.length).toBeGreaterThan(0);
    });

    it("identifies matching and new blocks with CDC chunking", async () => {
      const original = Buffer.alloc(300 * 1024);
      let seed = 123;
      for (let i = 0; i < original.length; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        original[i] = seed & 0xff;
      }

      const sigs = await buildSignatures(original, { chunking: "cdc", blockSize: 2048 });
      expect(sigs.length).toBeGreaterThanOrEqual(2);

      // Identical data produces all copy ops
      const deltaIdentical = await computeDelta(original, sigs, {
        chunking: "cdc",
        blockSize: 2048,
      });
      expect(deltaIdentical.ops.every((op) => op.type === "copy")).toBe(true);
      expect(deltaIdentical.literalBytes).toHaveLength(0);

      // Append 1000 bytes to test CDC delta generation
      const appended = Buffer.concat([original, Buffer.alloc(1000, 0xaa)]);
      const deltaAppended = await computeDelta(appended, sigs, {
        chunking: "cdc",
        blockSize: 2048,
      });

      // CDC should match the original chunks and emit literal for appended bytes
      const copyCount = deltaAppended.ops.filter((op) => op.type === "copy").length;
      expect(copyCount).toBeGreaterThan(0);
      const literalCount = deltaAppended.ops.filter((op) => op.type === "literal").length;
      expect(literalCount).toBeGreaterThan(0);
    });
  });

  describe("Zero-Copy Streaming File Operations", () => {
    const tmpDir = path.join(os.tmpdir(), "deltasync-stream-test-" + Date.now());
    const tmpFile = path.join(tmpDir, "large-sample.bin");

    beforeAll(() => {
      fs.mkdirSync(tmpDir, { recursive: true });
      // Create a 256 KB test file
      const buf = Buffer.alloc(256 * 1024);
      for (let i = 0; i < buf.length; i++) {
        buf[i] = (i * 31) & 0xff;
      }
      fs.writeFileSync(tmpFile, buf);
    });

    afterAll(() => {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("computes streaming contentHashFile matching whole-buffer hash", async () => {
      const wholeBuf = fs.readFileSync(tmpFile);
      const expected = await sha256Hex(wholeBuf);
      const streamedHash = await contentHashFile(tmpFile);
      expect(streamedHash).toBe(expected);
    });

    it("reads chunk slice on-demand directly from disk", async () => {
      const slice = await readChunkSlice(tmpFile, 1024, 2048);
      expect(slice.length).toBe(2048);

      const wholeBuf = fs.readFileSync(tmpFile);
      expect(slice).toEqual(wholeBuf.subarray(1024, 3072));
    });

    it("builds signatures from file matching memory signatures", async () => {
      const wholeBuf = fs.readFileSync(tmpFile);
      const memSigs = await buildSignatures(wholeBuf, { chunking: "fixed", blockSize: 4096 });
      const fileSigs = await buildSignaturesFromFile(tmpFile, {
        chunking: "fixed",
        blockSize: 4096,
      });

      expect(fileSigs.length).toBe(memSigs.length);
      for (let i = 0; i < memSigs.length; i++) {
        expect(fileSigs[i]!.strongHash).toBe(memSigs[i]!.strongHash);
        expect(fileSigs[i]!.offset).toBe(memSigs[i]!.offset);
        expect(fileSigs[i]!.length).toBe(memSigs[i]!.length);
      }
    });
  });
});
