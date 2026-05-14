import { Worker } from "bullmq";
import Redis from "ioredis";
import { runGarbageCollection } from "./gc";

const redisConnection = new Redis(process.env.REDIS_URL || "redis://localhost:6379", { maxRetriesPerRequest: null });

export const backgroundWorker = new Worker("background-jobs", async (job) => {
  switch (job.name) {
    case "run-gc":
      console.log(`[Worker] Executing garbage collection job: ${job.id}`);
      await runGarbageCollection();
      break;
    
    // Additional asynchronous jobs (e.g., applying patches, verifying file integrity) can be added here
    default:
      console.warn(`[Worker] Unknown job type: ${job.name}`);
  }
}, { connection: redisConnection });

backgroundWorker.on("completed", (job) => {
  console.log(`[Worker] Job ${job.id} has completed!`);
});

backgroundWorker.on("failed", (job, err) => {
  console.error(`[Worker] Job ${job?.id} has failed with ${err.message}`);
});

console.log("[Worker] Background worker process started, listening on 'background-jobs' queue.");
