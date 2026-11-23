import { describe, it, expect } from "vitest";
import { aggregateDailyTelemetry } from "../src/lib/telemetry-aggregator";

describe("aggregateDailyTelemetry", () => {
  it("fills zero-gaps for all 30 consecutive UTC days", () => {
    const ref = new Date("2026-11-24T12:00:00Z");
    const result = aggregateDailyTelemetry([], 30, ref);

    expect(result).toHaveLength(30);
    expect(result[0].day).toBe("2026-10-26");
    expect(result[29].day).toBe("2026-11-24");
    expect(result.every((b) => b.transferred === 0 && b.saved === 0 && b.jobs === 0)).toBe(true);
  });

  it("buckets sync telemetry rows into matching days correctly", () => {
    const ref = new Date("2026-11-24T12:00:00Z");
    const rows = [
      {
        createdAt: new Date("2026-11-24T02:00:00Z"),
        bytesTransferred: 1024,
        bytesSaved: 4096,
      },
      {
        createdAt: new Date("2026-11-24T05:30:00Z"),
        bytesTransferred: 2048,
        bytesSaved: 8192,
      },
      {
        createdAt: new Date("2026-11-23T18:00:00Z"),
        bytesTransferred: 512,
        bytesSaved: 1024,
      },
    ];

    const result = aggregateDailyTelemetry(rows, 7, ref);
    expect(result).toHaveLength(7);

    const today = result.find((b) => b.day === "2026-11-24");
    expect(today).toBeDefined();
    expect(today?.jobs).toBe(2);
    expect(today?.transferred).toBe(3072);
    expect(today?.saved).toBe(12288);

    const yesterday = result.find((b) => b.day === "2026-11-23");
    expect(yesterday?.jobs).toBe(1);
    expect(yesterday?.transferred).toBe(512);
    expect(yesterday?.saved).toBe(1024);
  });
});
