import { EventEmitter } from "node:events";

export interface JobEventPayload {
  jobId: string;
  status: string;
  filePath?: string;
}

export interface FileCommittedPayload {
  fileId: string;
  path: string;
  versionNo: number;
}

class OutboxNotifier extends EventEmitter {
  emitInserted() {
    this.emit("inserted");
  }

  emitJobUpdate(data: JobEventPayload) {
    this.emit("job:status", data);
  }

  emitFileCommitted(data: FileCommittedPayload) {
    this.emit("file:committed", data);
  }
}

export const outboxNotifier = new OutboxNotifier();
