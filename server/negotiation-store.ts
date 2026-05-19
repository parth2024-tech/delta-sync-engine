/**
 * In-memory negotiation store for Lite Mode.
 *
 * Supports resumable uploads:
 *   - getNegotiation() reads without consuming (allows retries)
 *   - clearNegotiation() explicitly consumes after successful commit
 *   - Extended TTL (1 hour) matches pre-signed URL expiry
 */

export interface NegotiationPayload {
  userId: string;
  path: string;
  chunking: "cdc" | "fixed";
  blockSize: number;
  newSize: number;
  contentSha256: string;
  chunks: { strongHash: string; length: number; weakHash?: number }[];
  snapshotCurrentVersionId: string | null;
}

const NEGOTIATION_TTL_MS = 60 * 60 * 1000; // 1 hour (matches pre-signed URL expiry)

const store = new Map<string, { payload: NegotiationPayload; expiresAt: number }>();

export function setNegotiation(id: string, payload: NegotiationPayload) {
  store.set(id, { payload, expiresAt: Date.now() + NEGOTIATION_TTL_MS });
}

/**
 * Read a negotiation without consuming it.
 * The negotiation remains valid for retries if commit fails.
 */
export function getNegotiation(id: string): NegotiationPayload | null {
  const entry = store.get(id);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    store.delete(id);
    return null;
  }
  return entry.payload;
}

/**
 * Consume and remove a negotiation after successful commit.
 */
export function clearNegotiation(id: string): void {
  store.delete(id);
}

/**
 * Legacy one-shot: read and clear in a single call.
 * @deprecated Use getNegotiation + clearNegotiation for resumable uploads.
 */
export function getAndClearNegotiation(id: string): NegotiationPayload | null {
  const payload = getNegotiation(id);
  if (payload) clearNegotiation(id);
  return payload;
}

// Cleanup expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of store.entries()) {
    if (entry.expiresAt < now) {
      store.delete(id);
    }
  }
}, 60000).unref();
