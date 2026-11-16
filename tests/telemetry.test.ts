import { describe, it, expect } from "vitest";
import { generateTraceContext, formatTraceparent, parseTraceparent } from "../cli/src/telemetry";
import { extractTraceContext } from "../server/telemetry";

describe("W3C Distributed Tracing Telemetry", () => {
  it("generates compliant trace context with 16B traceId and 8B spanId", () => {
    const ctx = generateTraceContext();
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(ctx.traceFlags).toBe("01");

    const header = formatTraceparent(ctx);
    expect(header).toBe(`00-${ctx.traceId}-${ctx.spanId}-01`);
  });

  it("parses valid traceparent header", () => {
    const raw = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const parsed = parseTraceparent(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(parsed?.spanId).toBe("00f067aa0ba902b7");
    expect(parsed?.traceFlags).toBe("01");
  });

  it("rejects invalid traceparent formats", () => {
    expect(parseTraceparent(null)).toBeNull();
    expect(parseTraceparent("")).toBeNull();
    expect(parseTraceparent("invalid-trace")).toBeNull();
    expect(parseTraceparent("01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBeNull(); // unsupported version
    expect(parseTraceparent("00-too-short-span-01")).toBeNull();
  });

  it("extracts trace context from HTTP Headers or creates new if missing", () => {
    const headers = new Headers();
    const fallback = extractTraceContext(headers);
    expect(fallback.traceId).toBeDefined();

    headers.set("traceparent", "00-11111111111111111111111111111111-2222222222222222-01");
    const extracted = extractTraceContext(headers);
    expect(extracted.traceId).toBe("11111111111111111111111111111111");
    expect(extracted.spanId).toBe("2222222222222222");
  });
});
