// Block signatures: fixed-size blocks or content-defined chunks (CDC).

import { cdcRanges } from "../../../shared/fastcdc";
import { adler32, adler32Hash, weak16 } from "./adler32";
import { sha256 } from "./strong-hash";

export interface BlockSignature {
  index: number;
  offset: number;
  length: number;
  weak: number;
  strong: string;
}

export const DEFAULT_BLOCK_SIZE = 1024;

export type ChunkingMode = "cdc" | "fixed";

export async function computeSignatures(
  bytes: Uint8Array,
  blockSize: number = DEFAULT_BLOCK_SIZE,
  mode: ChunkingMode = "cdc",
): Promise<BlockSignature[]> {
  if (mode === "fixed") {
    const sigs: BlockSignature[] = [];
    let index = 0;
    for (let offset = 0; offset < bytes.length; offset += blockSize) {
      const end = Math.min(offset + blockSize, bytes.length);
      const slice = bytes.subarray(offset, end);
      const weak = adler32Hash(adler32(slice));
      const strong = await sha256(slice);
      sigs.push({ index, offset, length: end - offset, weak, strong });
      index++;
    }
    return sigs;
  }

  const ranges = cdcRanges(bytes, {
    minSize: Math.max(256, Math.floor(blockSize / 4)),
    avgSize: blockSize,
    maxSize: Math.min(256 * 1024, blockSize * 32),
  });

  const sigs: BlockSignature[] = [];
  let index = 0;
  for (const { start, end } of ranges) {
    const slice = bytes.subarray(start, end);
    const weak = adler32Hash(adler32(slice));
    const strong = await sha256(slice);
    sigs.push({ index, offset: start, length: end - start, weak, strong });
    index++;
  }
  return sigs;
}

export { weak16 };
