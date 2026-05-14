import { describe, it, expect } from "vitest";
import { adler32, sha256Hex } from "./hash";

describe("Rolling Hash Algorithms", () => {
  it("computes accurate adler32 hash for identical inputs", () => {
    const data1 = new TextEncoder().encode("deltasync algorithm test block");
    const data2 = new TextEncoder().encode("deltasync algorithm test block");
    const hash1 = adler32(data1);
    const hash2 = adler32(data2);
    expect(hash1).toBe(hash2);
  });

  it("produces different adler32 hashes for shifted content", () => {
    const data1 = new TextEncoder().encode("deltasync algorithm test block");
    const data2 = new TextEncoder().encode("eltasync algorithm test block!");
    expect(adler32(data1)).not.toBe(adler32(data2));
  });

  it("computes accurate sha256 hex string", async () => {
    const data = new TextEncoder().encode("hello world");
    const hash = await sha256Hex(data);
    // sha256 of "hello world"
    expect(hash).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });
});
