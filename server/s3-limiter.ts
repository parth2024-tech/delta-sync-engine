/**
 * Limits concurrent S3 API calls to avoid connection storms / throttling.
 */

type Task<T> = () => Promise<T>;

export function createS3Limiter(maxConcurrent: number) {
  let active = 0;
  const queue: { run: Task<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];

  function pump() {
    while (active < maxConcurrent && queue.length > 0) {
      const job = queue.shift()!;
      active++;
      job
        .run()
        .then((v) => job.resolve(v), (e) => job.reject(e))
        .finally(() => {
          active--;
          pump();
        });
    }
  }

  return function run<T>(fn: Task<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push({
        run: fn as Task<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      pump();
    });
  };
}
