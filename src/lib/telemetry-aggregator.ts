/**
 * Portable, zero-dialect-lock-in daily telemetry bucketing.
 * Fills zero-valued gaps across consecutive UTC days so Recharts displays continuous axes.
 */
export interface DailyTelemetryBucket {
  day: string;
  transferred: number;
  saved: number;
  jobs: number;
}

export function aggregateDailyTelemetry(
  rows: Array<{ createdAt: Date | number; bytesTransferred: number; bytesSaved: number }>,
  days: 7 | 30 = 30,
  referenceDate: Date = new Date(),
): DailyTelemetryBucket[] {
  const buckets = new Map<string, DailyTelemetryBucket>();

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(
      Date.UTC(
        referenceDate.getUTCFullYear(),
        referenceDate.getUTCMonth(),
        referenceDate.getUTCDate() - i,
      ),
    );
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, { day: key, transferred: 0, saved: 0, jobs: 0 });
  }

  for (const row of rows) {
    const key = new Date(row.createdAt).toISOString().slice(0, 10);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.transferred += Number(row.bytesTransferred);
      bucket.saved += Number(row.bytesSaved);
      bucket.jobs += 1;
    }
  }

  return Array.from(buckets.values());
}
