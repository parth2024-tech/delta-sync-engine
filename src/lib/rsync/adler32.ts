// Adler-32 rolling hash — the weak hash used by rsync.
// Constant-time slide: O(1) per byte instead of O(B).
//
// Spec: A = 1 + Σ bytes; B = Σ A; checksum = (B << 16) | A, all mod 65521.
// For rsync we operate on a fixed window [i, i+blockSize), so we use the
// "rolling" form that updates A and B when one byte enters and another leaves.

const MOD_ADLER = 65521;

export interface Adler32State {
  a: number;
  b: number;
  blockSize: number;
}

export function adler32(bytes: Uint8Array, start = 0, end = bytes.length): Adler32State {
  let a = 1;
  let b = 0;
  for (let i = start; i < end; i++) {
    a = (a + bytes[i]) % MOD_ADLER;
    b = (b + a) % MOD_ADLER;
  }
  return { a, b, blockSize: end - start };
}

/**
 * Slide the window one byte forward: drop `outByte` from the left,
 * include `inByte` on the right. O(1).
 */
export function rollAdler32(state: Adler32State, outByte: number, inByte: number): Adler32State {
  const { blockSize } = state;
  // Add MOD_ADLER * blockSize keeps values positive before %.
  const a = (state.a - outByte + inByte + MOD_ADLER) % MOD_ADLER;
  const b =
    (state.b - blockSize * outByte + a - 1 + MOD_ADLER * (blockSize + 1)) % MOD_ADLER;
  return { a, b, blockSize };
}

export function adler32Hash(state: Adler32State): number {
  // Unsigned 32-bit.
  return ((state.b << 16) | state.a) >>> 0;
}

/** Lower 16 bits — used as the bucket key in the two-level lookup table. */
export function weak16(hash: number): number {
  return hash & 0xffff;
}
