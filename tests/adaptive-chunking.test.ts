/**
 * Tests for adaptive chunk sizing.
 */
import { describe, it, expect } from "vitest";
import { adaptiveChunkSize, SMALL_FILE_THRESHOLD } from "../cli/src/rsync";

describe("Adaptive Chunk Sizing", () => {
  it("returns 0 (skip CDC) for files below 32 KB", () => {
    expect(adaptiveChunkSize(0)).toBe(0);
    expect(adaptiveChunkSize(100)).toBe(0);
    expect(adaptiveChunkSize(1024)).toBe(0);
    expect(adaptiveChunkSize(10 * 1024)).toBe(0);
    expect(adaptiveChunkSize(SMALL_FILE_THRESHOLD - 1)).toBe(0);
  });

  it("returns 4096 for files between 32 KB and 256 KB", () => {
    expect(adaptiveChunkSize(SMALL_FILE_THRESHOLD)).toBe(4096);
    expect(adaptiveChunkSize(50 * 1024)).toBe(4096);
    expect(adaptiveChunkSize(128 * 1024)).toBe(4096);
    expect(adaptiveChunkSize(256 * 1024 - 1)).toBe(4096);
  });

  it("returns 16384 for files between 256 KB and 10 MB", () => {
    expect(adaptiveChunkSize(256 * 1024)).toBe(16384);
    expect(adaptiveChunkSize(1024 * 1024)).toBe(16384);
    expect(adaptiveChunkSize(5 * 1024 * 1024)).toBe(16384);
    expect(adaptiveChunkSize(10 * 1024 * 1024 - 1)).toBe(16384);
  });

  it("returns 65536 for files above 10 MB", () => {
    expect(adaptiveChunkSize(10 * 1024 * 1024)).toBe(65536);
    expect(adaptiveChunkSize(100 * 1024 * 1024)).toBe(65536);
    expect(adaptiveChunkSize(1024 * 1024 * 1024)).toBe(65536);
  });

  it("SMALL_FILE_THRESHOLD is 32 KB", () => {
    expect(SMALL_FILE_THRESHOLD).toBe(32768);
  });
});
