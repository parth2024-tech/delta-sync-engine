import crypto from "node:crypto";

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceFlags: string;
}

export function generateTraceContext(parent?: TraceContext): TraceContext {
  return {
    traceId: parent?.traceId ?? crypto.randomBytes(16).toString("hex"),
    spanId: crypto.randomBytes(8).toString("hex"),
    traceFlags: parent?.traceFlags ?? "01",
  };
}

export function formatTraceparent(ctx: TraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.traceFlags}`;
}

export function parseTraceparent(header: string | null | undefined): TraceContext | null {
  if (!header) return null;
  const parts = header.trim().split("-");
  if (parts.length !== 4 || parts[0] !== "00") return null;
  if (parts[1].length !== 32 || parts[2].length !== 16 || parts[3].length !== 2) return null;
  return { traceId: parts[1], spanId: parts[2], traceFlags: parts[3] };
}

export function extractTraceContext(
  headers: Headers | Record<string, string | string[] | undefined>,
): TraceContext {
  let headerVal: string | null | undefined;
  if (headers instanceof Headers) {
    headerVal = headers.get("traceparent");
  } else {
    const raw = headers["traceparent"];
    headerVal = Array.isArray(raw) ? raw[0] : raw;
  }
  const parsed = parseTraceparent(headerVal);
  return parsed ?? generateTraceContext();
}
