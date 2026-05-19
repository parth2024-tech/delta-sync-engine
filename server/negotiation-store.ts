// In-memory negotiation store for Lite Mode

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

const store = new Map<string, { payload: NegotiationPayload; expiresAt: number }>();

export function setNegotiation(id: string, payload: NegotiationPayload) {
  store.set(id, { payload, expiresAt: Date.now() + 10 * 60 * 1000 }); // 10 minutes
}

export function getAndClearNegotiation(id: string): NegotiationPayload | null {
  const entry = store.get(id);
  if (!entry) return null;
  store.delete(id);
  if (entry.expiresAt < Date.now()) return null;
  return entry.payload;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of store.entries()) {
    if (entry.expiresAt < now) {
      store.delete(id);
    }
  }
}, 60000).unref();
