import { spawnSync } from "node:child_process";
import path from "node:path";
import { readFileSync, writeFileSync, statSync, existsSync } from "fs";
import {
  getFile,
  upsertFile,
  recordChunkStatus,
  getCompletedChunks,
  clearNegotiationChunks,
  getNegotiationSession,
  saveNegotiationSession,
  deleteNegotiationSession,
  getOrCreateSyncSession,
  setSessionFileState,
  updateSyncSessionState,
} from "./db.js";
import { buildSignatures, adaptiveChunkSize, contentHash } from "./rsync.js";
import * as api from "./api.js";
import { fetchWithTimeout, sleepWithJitter } from "./api.js";
import type { Config } from "./config.js";

const UPLOAD_CONCURRENCY = Math.max(
  1,
  Math.min(32, parseInt(process.env.DELTASYNC_CONCURRENCY || "8", 10) || 8),
);

function fmtBytes(b: number) {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(1)} KB`;
  return `${b} B`;
}

/** Zero-dependency concurrent task runner. */
async function parallelLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const promises: Promise<void>[] = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const curIndex = index++;
      const item = items[curIndex]!;
      results[curIndex] = await fn(item);
    }
  }

  for (let i = 0; i < Math.min(limit, items.length); i++) {
    promises.push(worker());
  }
  await Promise.all(promises);
  return results;
}

/**
 * Shared push logic for pushing a local file to the server.
 * Completely fault-tolerant and resume-aware:
 *   1. Performs Staging Area Reconciliation against local session & S3 staging
 *   2. Generates/resumes negotiation sessions
 *   3. Performs Sparse Payload Reconstruction to upload ONLY missing chunks
 *   4. Streams chunk uploads in parallel with atomic journaling
 */
export async function performPush(
  filePath: string,
  cfg: Config,
  sessionId?: string,
): Promise<{ versionNo: number; bytesSaved: number }> {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const activeSessionId =
    sessionId ?? getOrCreateSyncSession(path.dirname(path.resolve(filePath))).sessionId;

  const stat = statSync(filePath);
  setSessionFileState(activeSessionId, filePath, "pending", { fileSize: stat.size });

  const data = readFileSync(filePath);
  const hash = await contentHash(data);
  const cached = getFile(filePath);

  if (cached?.last_hash === hash) {
    console.log(`✓ ${filePath} — unchanged, skipping`);
    setSessionFileState(activeSessionId, filePath, "skipped", { hash, fileSize: stat.size });
    return { versionNo: cached.server_version, bytesSaved: 0 };
  }

  setSessionFileState(activeSessionId, filePath, "hashed", { hash, fileSize: stat.size });

  // 1. STATEFUL RECONCILIATION: Check if we have an active negotiation session for this file path
  let session = getNegotiationSession(filePath);
  let negotiationId: string | null = null;
  let missingChunks: { strongHash: string; uploadUrl: string }[] = [];

  const adaptiveSize = adaptiveChunkSize(data.length);
  const blockSize = adaptiveSize > 0 ? adaptiveSize : 16384;

  console.log(
    `Building variable signatures for ${filePath} (CDC average: ${fmtBytes(blockSize)})…`,
  );
  const sigs = await buildSignatures(data, { chunking: "cdc", blockSize });

  // Map signatures to negotiate schema chunks list
  const chunkList = sigs.map((s) => ({
    strongHash: s.strongHash,
    length: s.length,
    weakHash: s.weakHash,
  }));

  if (session && session.contentSha256 === hash) {
    console.log(
      `[ResumeEngine] Found incomplete session for ${filePath}. Reconciling staging area…`,
    );
    try {
      const resumeResult = await api.resumeNegotiation(cfg, session.negotiationId);
      negotiationId = resumeResult.negotiationId;
      missingChunks = resumeResult.missingChunks;
      console.log(
        `[ResumeEngine] Reconciled: ${resumeResult.alreadyUploaded}/${resumeResult.totalChunks} chunks already committed. Resuming Sync.`,
      );
    } catch (err) {
      console.warn(
        `[ResumeEngine] Failed to resume session ${session.negotiationId}: ${(err as Error).message}. Starting new negotiation.`,
      );
      deleteNegotiationSession(filePath);
      session = undefined;
    }
  }

  if (!negotiationId) {
    console.log(`[ResumeEngine] Initiating new negotiation handshake…`);
    const negotiateResult = await api.negotiate(cfg, {
      path: filePath,
      chunking: "cdc",
      blockSize,
      newSize: data.length,
      contentSha256: hash,
      chunks: chunkList,
    });
    negotiationId = negotiateResult.negotiationId;
    missingChunks = negotiateResult.missingChunks;
    saveNegotiationSession(filePath, negotiationId, hash);
    console.log(`[ResumeEngine] Handshake successful. negotiationId: ${negotiationId}`);
  }

  setSessionFileState(activeSessionId, filePath, "negotiated", {
    hash,
    negotiationId,
    totalChunks: chunkList.length,
    uploadedChunks: chunkList.length - missingChunks.length,
  });

  // 2. SPARSE PAYLOAD RECONSTRUCTION: Skip local database-journaled completed chunks
  const completedLocal = getCompletedChunks(negotiationId);
  const remainingUploads = missingChunks.filter((c) => !completedLocal.has(c.strongHash));

  const skippedLocalCount = missingChunks.length - remainingUploads.length;
  if (skippedLocalCount > 0) {
    console.log(
      `[ResumeEngine] Journal check: skipped ${skippedLocalCount} locally completed chunks.`,
    );
  }

  // 3. HIGH-CONCURRENCY CHUNK STREAMING
  if (remainingUploads.length > 0) {
    console.log(
      `[ResumeEngine] Uploading ${remainingUploads.length} missing chunks directly to S3 (concurrency: ${UPLOAD_CONCURRENCY})…`,
    );

    // Map each chunk to its corresponding signature to find offset
    const uploadsWithMetadata = remainingUploads.map((c) => {
      const sig = sigs.find((s) => s.strongHash === c.strongHash);
      if (!sig) throw new Error(`Hash mismatch for chunk ${c.strongHash}`);
      return { ...c, offset: sig.offset, length: sig.length };
    });

    let activeLimit = UPLOAD_CONCURRENCY;
    let consecutiveSuccesses = 0;
    let activeWorkers = 0;
    let uploadError: Error | null = null;
    const taskQueue = [...uploadsWithMetadata];

    await new Promise<void>((resolve, reject) => {
      const spawnWorkers = () => {
        if (uploadError) {
          if (activeWorkers === 0) reject(uploadError);
          return;
        }

        if (taskQueue.length === 0 && activeWorkers === 0) {
          resolve();
          return;
        }

        while (activeWorkers < activeLimit && taskQueue.length > 0 && !uploadError) {
          const chunk = taskQueue.shift();
          if (!chunk) break;

          activeWorkers++;
          const chunkData = data.subarray(chunk.offset, chunk.offset + chunk.length);

          (async () => {
            let attempts = 3;
            const startTime = Date.now();

            while (attempts > 0 && !uploadError) {
              try {
                const r = await fetchWithTimeout(
                  chunk.uploadUrl,
                  {
                    method: "PUT",
                    body: chunkData,
                    headers: {
                      "Content-Type": "application/octet-stream",
                      "Content-Length": String(chunk.length),
                    },
                  },
                  30000,
                );

                if (r.status === 503 || r.status === 429) {
                  activeLimit = Math.max(1, activeLimit - 1);
                  consecutiveSuccesses = 0;
                  console.warn(
                    `[S3:Concurrency] HTTP ${r.status} Slow Down detected for chunk ${chunk.strongHash}. ` +
                      `Scaling concurrency limit down to ${activeLimit}.`,
                  );
                  attempts--;
                  if (attempts > 0) {
                    await sleepWithJitter(3 - attempts, 1000, 30000);
                    continue;
                  }
                  throw new Error(`S3 rate limit exceeded (HTTP ${r.status})`);
                }

                if (!r.ok) {
                  throw new Error(`HTTP ${r.status} ${r.statusText}`);
                }

                const latency = Date.now() - startTime;
                if (latency < 400) {
                  consecutiveSuccesses++;
                  if (consecutiveSuccesses >= 5) {
                    const prevLimit = activeLimit;
                    activeLimit = Math.min(UPLOAD_CONCURRENCY, activeLimit + 1);
                    if (activeLimit > prevLimit) {
                      console.log(
                        `[S3:Concurrency] Low latency observed (${latency}ms). Scaling concurrency limit up to ${activeLimit}.`,
                      );
                    }
                    consecutiveSuccesses = 0;
                  }
                } else {
                  consecutiveSuccesses = 0;
                }

                recordChunkStatus(negotiationId!, chunk.strongHash, "completed");
                break;
              } catch (err: unknown) {
                attempts--;
                const errMsg = err instanceof Error ? err.message : String(err);
                if (attempts === 0) {
                  console.error(
                    `[ResumeEngine] ✗ Failed to upload chunk ${chunk.strongHash}: ${errMsg}`,
                  );
                  uploadError = err instanceof Error ? err : new Error(String(err));
                  break;
                }
                await sleepWithJitter(3 - attempts, 1000, 30000);
              }
            }
          })().finally(() => {
            activeWorkers--;
            spawnWorkers();
          });
        }
      };

      spawnWorkers();
    });
  } else {
    console.log(`[ResumeEngine] All chunks are already uploaded to S3 staging.`);
  }

  // 4. ATOMIC SYNC SEALING & COMMIT
  setSessionFileState(activeSessionId, filePath, "committing", {
    negotiationId,
    hash,
    totalChunks: chunkList.length,
    uploadedChunks: chunkList.length,
  });

  console.log(`[ResumeEngine] Committing upload to server…`);
  const commitResult = await api.commitSync(cfg, negotiationId);

  // Clear local journal & session records on success
  clearNegotiationChunks(negotiationId);
  deleteNegotiationSession(filePath);

  upsertFile(filePath, stat.mtimeMs, stat.size, hash, commitResult.versionNo);
  setSessionFileState(activeSessionId, filePath, "committed", {
    hash,
    totalChunks: chunkList.length,
    uploadedChunks: chunkList.length,
  });
  updateSyncSessionState(activeSessionId, "completed");
  const savedPct = data.length > 0 ? Math.round((commitResult.bytesSaved / data.length) * 100) : 0;
  console.log(
    `✓ pushed v${commitResult.versionNo} — saved ${fmtBytes(commitResult.bytesSaved)} (${savedPct}%)`,
  );

  return commitResult;
}
