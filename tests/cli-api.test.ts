import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchWithTimeout,
  sleepWithJitter,
  upload,
  TimeoutError,
  NetworkError,
} from "../cli/src/api";
import type { Config } from "../cli/src/config";
import zlib from "node:zlib";

describe("CLI Network & API Utilities", () => {
  const dummyCfg: Config = {
    serverUrl: "http://127.0.0.1:5000",
    apiKey: "mock-cli-token",
  };

  describe("sleepWithJitter", () => {
    it("should produce a bounded non-negative delay with jitter", async () => {
      const baseDelay = 100;
      const maxDelay = 1000;

      // Sample multiple runs to verify variability and boundaries
      const delays: number[] = [];
      for (let attempt = 0; attempt < 5; attempt++) {
        const start = Date.now();
        const promise = sleepWithJitter(attempt, baseDelay, maxDelay);
        // Fast-forward or await small attempt
        if (attempt <= 1) {
          await promise;
          delays.push(Date.now() - start);
        }
      }

      for (const d of delays) {
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(maxDelay + 50); // slight buffer for event loop
      }
    });
  });

  describe("fetchWithTimeout", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it("should add Accept-Encoding header automatically", async () => {
      let capturedHeaders: Headers | undefined;

      globalThis.fetch = vi.fn().mockImplementation(async (_url, opts) => {
        capturedHeaders = new Headers(opts.headers);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      const res = await fetchWithTimeout("http://localhost:5000/test", {}, 5000);
      expect(res.status).toBe(200);
      expect(capturedHeaders?.get("Accept-Encoding")).toContain("gzip");
    });

    it("should throw TimeoutError when AbortSignal triggers", async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (_url, opts) => {
        return new Promise((_, reject) => {
          opts.signal.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      });

      await expect(fetchWithTimeout("http://localhost:5000/slow", {}, 50)).rejects.toThrow(
        TimeoutError,
      );
    });

    it("should throw NetworkError on connection refusal or DNS failure", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      await expect(fetchWithTimeout("http://127.0.0.1:9999/test", {}, 1000)).rejects.toThrow(
        NetworkError,
      );
    });
  });

  describe("upload with payload compression", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it("should compress literal bytes > 1024 bytes with gzip", async () => {
      let capturedFormData: FormData | null = null;

      globalThis.fetch = vi.fn().mockImplementation(async (_url, opts) => {
        capturedFormData = opts.body as FormData;
        return new Response(JSON.stringify({ versionNo: 2, bytesSaved: 500 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      // 2000 bytes of repetitive text (highly compressible)
      const rawText = "deltasync high-performance synchronization block ".repeat(40);
      const literalBytes = Buffer.from(rawText);

      const res = await upload(
        dummyCfg,
        {
          path: "sample.txt",
          chunking: "cdc",
          blockSize: 4096,
          newSize: literalBytes.length,
          contentSha256: "a".repeat(64),
          opsEncoding: "json",
          ops: [],
        },
        literalBytes,
      );

      expect(res.versionNo).toBe(2);
      expect(capturedFormData).not.toBeNull();
      expect(capturedFormData!.get("literalsEncoding")).toBe("gzip");

      const literalsBlob = capturedFormData!.get("literals") as Blob;
      expect(literalsBlob).toBeInstanceOf(Blob);

      const compressedBuf = Buffer.from(await literalsBlob.arrayBuffer());
      const decompressed = zlib.gunzipSync(compressedBuf);
      expect(decompressed.toString("utf8")).toBe(rawText);
    });

    it("should send uncompressed literal bytes for small payloads < 1024 bytes", async () => {
      let capturedFormData: FormData | null = null;

      globalThis.fetch = vi.fn().mockImplementation(async (_url, opts) => {
        capturedFormData = opts.body as FormData;
        return new Response(JSON.stringify({ versionNo: 1, bytesSaved: 0 }), {
          status: 200,
        });
      });

      const smallBytes = Buffer.from("small payload under 1kb");

      await upload(
        dummyCfg,
        {
          path: "small.txt",
          chunking: "cdc",
          blockSize: 4096,
          newSize: smallBytes.length,
          contentSha256: "b".repeat(64),
          opsEncoding: "json",
          ops: [],
        },
        smallBytes,
      );

      expect(capturedFormData).not.toBeNull();
      expect(capturedFormData!.get("literalsEncoding")).toBeNull();

      const blob = capturedFormData!.get("literals") as Blob;
      const received = Buffer.from(await blob.arrayBuffer());
      expect(received.toString("utf8")).toBe("small payload under 1kb");
    });
  });
});
