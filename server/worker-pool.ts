import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, "worker.ts");

interface Task {
  id: string;
  versionId: string;
  totalBlocks: number;
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface WorkerHandle {
  id: string;
  worker: Worker;
  type: "fast" | "heavy";
  busy: boolean;
  currentTask: Task | null;
}

const WORKER_BOOTSTRAP = `
const { parentPort } = require('node:worker_threads');
try {
  const { register } = require('tsx/preprocessor/api');
  register();
} catch {}

const { handleVerifyChunks } = require('${WORKER_PATH.replace(/\\/g, "/")}');

parentPort.on('message', async (task) => {
  try {
    await handleVerifyChunks(task.versionId);
    parentPort.postMessage({ id: task.id, status: 'success' });
  } catch (err) {
    parentPort.postMessage({ id: task.id, status: 'error', error: String(err) });
  }
});
`;

class PersistentWorkStealingPool {
  private fastQueue: Task[] = [];
  private heavyQueue: Task[] = [];
  private workers: WorkerHandle[] = [];
  private maxFast = 4;
  private maxHeavy = 2;

  submit(versionId: string, totalBlocks: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const task: Task = {
        id: crypto.randomUUID(),
        versionId,
        totalBlocks,
        resolve,
        reject,
      };

      if (totalBlocks > 2000) {
        this.heavyQueue.push(task);
      } else {
        this.fastQueue.push(task);
      }

      this.processQueues();
    });
  }

  private createWorker(type: "fast" | "heavy"): WorkerHandle {
    const handle: WorkerHandle = {
      id: crypto.randomUUID(),
      worker: new Worker(WORKER_BOOTSTRAP, { eval: true }),
      type,
      busy: false,
      currentTask: null,
    };

    handle.worker.on("message", (msg) => {
      if (handle.currentTask && handle.currentTask.id === msg.id) {
        if (msg.status === "success") {
          handle.currentTask.resolve();
        } else {
          handle.currentTask.reject(new Error(msg.error));
        }
        handle.currentTask = null;
      }
      handle.busy = false;
      this.processQueues();
    });

    handle.worker.on("error", (err) => {
      if (handle.currentTask) {
        handle.currentTask.reject(err);
        handle.currentTask = null;
      }
      handle.busy = false;
      this.workers = this.workers.filter((w) => w !== handle);
      handle.worker.terminate().catch(() => {});
      this.processQueues();
    });

    handle.worker.on("exit", () => {
      if (handle.currentTask) {
        handle.currentTask.reject(new Error("Worker thread exited unexpectedly"));
        handle.currentTask = null;
      }
      this.workers = this.workers.filter((w) => w !== handle);
      this.processQueues();
    });

    this.workers.push(handle);
    return handle;
  }

  private getIdleWorker(type: "fast" | "heavy"): WorkerHandle | null {
    // 1. Try to find existing idle worker of requested type
    const existing = this.workers.find((w) => w.type === type && !w.busy);
    if (existing) return existing;

    // 2. Try to spawn new worker if below capacity
    const currentCount = this.workers.filter((w) => w.type === type).length;
    const max = type === "fast" ? this.maxFast : this.maxHeavy;
    if (currentCount < max) {
      return this.createWorker(type);
    }

    // 3. Work-Stealing: look for idle worker of opposite type
    const oppositeType = type === "fast" ? "heavy" : "fast";
    const idleOpposite = this.workers.find((w) => w.type === oppositeType && !w.busy);
    if (idleOpposite) return idleOpposite;

    // 4. Try to spawn opposite worker if opposite has capacity to help
    const oppCount = this.workers.filter((w) => w.type === oppositeType).length;
    const oppMax = oppositeType === "fast" ? this.maxFast : this.maxHeavy;
    if (oppCount < oppMax) {
      return this.createWorker(oppositeType);
    }

    return null;
  }

  private processQueues() {
    // Process Heavy Queue tasks
    while (this.heavyQueue.length > 0) {
      const worker = this.getIdleWorker("heavy");
      if (!worker) break;
      const task = this.heavyQueue.shift()!;
      this.dispatch(worker, task);
    }

    // Process Fast Queue tasks
    while (this.fastQueue.length > 0) {
      const worker = this.getIdleWorker("fast");
      if (!worker) break;
      const task = this.fastQueue.shift()!;
      this.dispatch(worker, task);
    }
  }

  private dispatch(worker: WorkerHandle, task: Task) {
    worker.busy = true;
    worker.currentTask = task;
    worker.worker.postMessage({ id: task.id, versionId: task.versionId });
  }

  public async terminate(): Promise<void> {
    const promises = this.workers.map((w) => w.worker.terminate());
    this.workers = [];
    await Promise.all(promises);
  }
}

export const workerPool = new PersistentWorkStealingPool();
export type { PersistentWorkStealingPool as WorkStealingPool };
