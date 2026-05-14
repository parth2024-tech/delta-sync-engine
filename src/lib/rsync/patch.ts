// Apply delta ops + the old file → reconstruct new file.

import type { BlockSignature } from "./signatures";
import type { DeltaOp } from "./delta";

export function applyDelta(
  oldBytes: Uint8Array,
  oldSignatures: BlockSignature[],
  ops: DeltaOp[],
  newSize: number,
): Uint8Array {
  const out = new Uint8Array(newSize);
  for (const op of ops) {
    if (op.type === "copy") {
      const sig = oldSignatures[op.blockIndex];
      out.set(oldBytes.subarray(sig.offset, sig.offset + sig.length), op.offset);
    } else {
      out.set(op.bytes, op.offset);
    }
  }
  return out;
}
