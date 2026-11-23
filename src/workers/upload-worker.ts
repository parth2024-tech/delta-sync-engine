import { cdcRanges } from "../../shared/fastcdc";

export interface WorkerInputMessage {
  fileData: ArrayBuffer;
  fileName: string;
  opts?: { minSize: number; avgSize: number; maxSize: number };
}

export interface WorkerChunkData {
  blockIndex: number;
  offset: number;
  length: number;
  strongHash: string;
}

export interface WorkerProgressMessage {
  type: "progress";
  chunksProcessed: number;
  totalChunks: number;
  bytesHashed: number;
  totalBytes: number;
}

export interface WorkerDoneMessage {
  type: "done";
  fileName: string;
  totalBytes: number;
  chunks: WorkerChunkData[];
  contentSha256: string;
}

export interface WorkerErrorMessage {
  type: "error";
  error: string;
}

export type WorkerOutputMessage = WorkerProgressMessage | WorkerDoneMessage | WorkerErrorMessage;

self.onmessage = async (e: MessageEvent<WorkerInputMessage>) => {
  try {
    const { fileData, fileName, opts } = e.data;
    const uint8 = new Uint8Array(fileData);
    const len = uint8.length;

    const cdcOpts = {
      minSize: opts?.minSize ?? 2048,
      avgSize: opts?.avgSize ?? 4096,
      maxSize: opts?.maxSize ?? 16384,
    };

    // 1. Content-defined chunk boundaries
    const ranges = cdcRanges(uint8, cdcOpts);
    const totalChunks = ranges.length;
    const chunks: WorkerChunkData[] = [];

    // 2. Hash each chunk
    for (let idx = 0; idx < totalChunks; idx++) {
      const range = ranges[idx];
      const chunkSlice = uint8.subarray(range.start, range.end);
      const hashBuffer = await crypto.subtle.digest("SHA-256", chunkSlice);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const sha256Hex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

      chunks.push({
        blockIndex: idx,
        offset: range.start,
        length: range.end - range.start,
        strongHash: sha256Hex,
      });

      if (idx % 8 === 0 || idx === totalChunks - 1) {
        const progressMsg: WorkerProgressMessage = {
          type: "progress",
          chunksProcessed: idx + 1,
          totalChunks,
          bytesHashed: range.end,
          totalBytes: len,
        };
        self.postMessage(progressMsg);
      }
    }

    // 3. Whole-file SHA-256
    const fullHashBuffer = await crypto.subtle.digest("SHA-256", uint8);
    const fullHashArray = Array.from(new Uint8Array(fullHashBuffer));
    const fullSha256Hex = fullHashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

    const doneMsg: WorkerDoneMessage = {
      type: "done",
      fileName,
      totalBytes: len,
      chunks,
      contentSha256: fullSha256Hex,
    };
    self.postMessage(doneMsg);
  } catch (err: unknown) {
    const errorMsg: WorkerErrorMessage = {
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(errorMsg);
  }
};
