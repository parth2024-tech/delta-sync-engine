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
  reject: (err: any) => void;
}

class WorkStealingPool {
  private fastQueue: Task[] = [];
  private heavyQueue: Task[] = [];
  private activeFast = 0;
  private activeHeavy = 0;
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

      // Manifest files with more than 2000 blocks go to the heavy queue.
      // Small structural manifests go to the fast queue to prevent stalling.
      if (totalBlocks > 2000) {
        this.heavyQueue.push(task);
      } else {
        this.fastQueue.push(task);
      }

      this.processQueues();
    });
  }

  private processQueues() {
    // Process Heavy Queue
    while (this.activeHeavy < this.maxHeavy && this.heavyQueue.length > 0) {
      const task = this.heavyQueue.shift()!;
      this.runTask(task, "heavy");
    }

    // Process Fast Queue
    while (this.activeFast < this.maxFast && this.fastQueue.length > 0) {
      const task = this.fastQueue.shift()!;
      this.runTask(task, "fast");
    }

    // Work-Stealing: Heavy workers steal from Fast Queue if idle
    while (this.activeHeavy < this.maxHeavy && this.fastQueue.length > 0) {
      const task = this.fastQueue.shift()!;
      console.log(`[WorkerPool] Heavy worker stole task ${task.versionId} (blocks: ${task.totalBlocks}) from fast queue`);
      this.runTask(task, "heavy");
    }

    // Work-Stealing: Fast workers steal from Heavy Queue to help out if idle
    while (this.activeFast < this.maxFast && this.heavyQueue.length > 0) {
      const task = this.heavyQueue.shift()!;
      console.log(`[WorkerPool] Fast worker stole task ${task.versionId} (blocks: ${task.totalBlocks}) from heavy queue`);
      this.runTask(task, "fast");
    }
  }

  private runTask(task: Task, type: "fast" | "heavy") {
    if (type === "fast") this.activeFast++;
    else this.activeHeavy++;

    // Spawn inline worker that registers tsx dynamically
    const worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const { register } = require('tsx/preprocessor/api');
      register(); // Register dynamic tsx preprocessor loader
      const { handleVerifyChunks } = require('${WORKER_PATH.replace(/\\/g, "/")}');

      async function main() {
        try {
          await handleVerifyChunks(workerData.versionId);
          parentPort.postMessage({ status: 'success' });
        } catch (err) {
          parentPort.postMessage({ status: 'error', error: String(err) });
        }
      }
      main().catch(err => parentPort.postMessage({ status: 'fatal', error: String(err) }));
      `,
      {
        eval: true,
        workerData: { versionId: task.versionId },
      }
    );

    worker.on("message", (msg) => {
      if (msg.status === "success") {
        task.resolve();
      } else {
        task.reject(new Error(msg.error));
      }
    });

    worker.on("error", (err) => {
      task.reject(err);
    });

    worker.on("exit", () => {
      if (type === "fast") this.activeFast--;
      else this.activeHeavy--;
      this.processQueues();
    });
  }
}

export const workerPool = new WorkStealingPool();
export type { WorkStealingPool };
