/**
 * Native Bridge — Zero-copy async FFI interface to the Rust NAPI-RS addon.
 *
 * Loads the compiled `deltasync-native` addon for CDC chunking, Adler-32,
 * and SHA-256 hashing on Rayon's thread pool. Falls back to pure TypeScript
 * implementations if the native binary is not available (dev/CI).
 *
 * Usage:
 *   import { native } from "./native-bridge";
 *   const result = await native.cdcChunkAndHash(buffer, 16384);
 */

import { adler32 } from "../shared/hash";
import { cdcChunkEnds } from "../shared/fastcdc";
import crypto from "node:crypto";

// ── Types matching the NAPI-RS exports ────────────────────────────────────────

export interface ChunkResult {
  blockIndex: number;
  offset: number;
  length: number;
  weakHash: number;
  strongHashHex: string;
}

export interface CdcHashResult {
  chunks: ChunkResult[];
  contentSha256: string;
}

export interface NativeBridge {
  /** True if using the compiled Rust addon; false if using JS fallback. */
  isNative: boolean;

  /** Synchronous Adler-32 checksum. */
  adler32Native(data: Uint8Array): number;

  /** Async SHA-256 hex hash (offloaded to worker thread in native mode). */
  sha256Native(data: Uint8Array): Promise<string>;

  /** Full CDC chunk + hash pipeline (parallel Rayon in native mode). */
  cdcChunkAndHash(data: Uint8Array, avgSize?: number): Promise<CdcHashResult>;

  /** Hash a batch of literal chunks defined by offset/length arrays. */
  hashLiteralChunks(
    data: Uint8Array,
    offsets: number[],
    lengths: number[],
  ): Promise<ChunkResult[]>;
}

// ── Pure TypeScript Fallback ──────────────────────────────────────────────────

function sha256HexSync(data: Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

const tsFallback: NativeBridge = {
  isNative: false,

  adler32Native(data: Uint8Array): number {
    return adler32(data);
  },

  async sha256Native(data: Uint8Array): Promise<string> {
    return sha256HexSync(data);
  },

  async cdcChunkAndHash(
    data: Uint8Array,
    avgSize = 16384,
  ): Promise<CdcHashResult> {
    const contentSha256 = sha256HexSync(data);

    const ends = cdcChunkEnds(data, {
      minSize: Math.max(512, Math.floor(avgSize / 4)),
      avgSize,
      maxSize: Math.min(4 * 1024 * 1024, avgSize * 64),
    });

    const chunks: ChunkResult[] = [];
    let prev = 0;
    for (let i = 0; i < ends.length; i++) {
      const end = ends[i]!;
      const slice = data.subarray(prev, end);
      chunks.push({
        blockIndex: i,
        offset: prev,
        length: end - prev,
        weakHash: adler32(slice),
        strongHashHex: sha256HexSync(slice),
      });
      prev = end;
    }

    return { chunks, contentSha256 };
  },

  async hashLiteralChunks(
    data: Uint8Array,
    offsets: number[],
    lengths: number[],
  ): Promise<ChunkResult[]> {
    const results: ChunkResult[] = [];
    for (let i = 0; i < offsets.length; i++) {
      const off = offsets[i]!;
      const len = lengths[i]!;
      const slice = data.subarray(off, off + len);
      results.push({
        blockIndex: i,
        offset: off,
        length: len,
        weakHash: adler32(slice),
        strongHashHex: sha256HexSync(slice),
      });
    }
    return results;
  },
};

// ── Load Native Addon with Graceful Fallback ──────────────────────────────────

function loadNativeAddon(): NativeBridge {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const addon = require("../native/deltasync-native.node");

    const bridge: NativeBridge = {
      isNative: true,
      adler32Native: addon.adler32Native,
      sha256Native: addon.sha256Native,
      cdcChunkAndHash: addon.cdcChunkAndHash,
      hashLiteralChunks: addon.hashLiteralChunks,
    };

    console.log("[NativeBridge] ✓ Loaded Rust NAPI-RS addon (Rayon thread pool active)");
    return bridge;
  } catch (e) {
    console.warn(
      `[NativeBridge] ⚠ Rust addon not found, using TypeScript fallback. ` +
      `Build with: cd native && npm run build\n` +
      `  Reason: ${(e as Error).message}`,
    );
    return tsFallback;
  }
}

/** The singleton native bridge instance. */
export const native: NativeBridge = loadNativeAddon();
