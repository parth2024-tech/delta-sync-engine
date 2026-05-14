// Block signatures: split file into fixed-size blocks and emit
// {offset, length, weak (Adler-32), strong (SHA-256)} for each.

import { adler32, adler32Hash } from "./adler32";
import { sha256 } from "./strong-hash";

export interface BlockSignature {
  index: number;
  offset: number;
  length: number;
  weak: number;
  strong: string;
}

export const DEFAULT_BLOCK_SIZE = 1024; // small for in-browser demo; CLI uses 4096+

export async function computeSignatures(
  bytes: Uint8Array,
  blockSize: number = DEFAULT_BLOCK_SIZE,
): Promise<BlockSignature[]> {
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
