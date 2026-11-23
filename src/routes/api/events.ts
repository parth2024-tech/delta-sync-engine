import { createFileRoute } from "@tanstack/react-router";
import { verifySessionToken } from "../../../server/auth";
import {
  outboxNotifier,
  type JobEventPayload,
  type FileCommittedPayload,
} from "../../../server/outbox-notifier";

function getSessionToken(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)ds_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export const Route = createFileRoute("/api/events")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = getSessionToken(request);
        if (!token) {
          return new Response("Unauthorized", { status: 401 });
        }

        const userId = await verifySessionToken(token);
        if (!userId) {
          return new Response("Invalid session", { status: 401 });
        }

        const encoder = new TextEncoder();
        let pingTimer: NodeJS.Timeout | null = null;
        let onJobStatus: ((data: JobEventPayload) => void) | null = null;
        let onFileCommitted: ((data: FileCommittedPayload) => void) | null = null;

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            // Initial connection acknowledgment
            controller.enqueue(encoder.encode(": connected\n\n"));

            onJobStatus = (data: JobEventPayload) => {
              try {
                controller.enqueue(
                  encoder.encode(`event: job:status\ndata: ${JSON.stringify(data)}\n\n`),
                );
              } catch {
                // Stream closed
              }
            };

            onFileCommitted = (data: FileCommittedPayload) => {
              try {
                controller.enqueue(
                  encoder.encode(`event: file:committed\ndata: ${JSON.stringify(data)}\n\n`),
                );
              } catch {
                // Stream closed
              }
            };

            outboxNotifier.on("job:status", onJobStatus);
            outboxNotifier.on("file:committed", onFileCommitted);

            // Keepalive ping every 25s
            pingTimer = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(": ping\n\n"));
              } catch {
                if (pingTimer) clearInterval(pingTimer);
              }
            }, 25000);
          },
          cancel() {
            if (pingTimer) clearInterval(pingTimer);
            if (onJobStatus) outboxNotifier.off("job:status", onJobStatus);
            if (onFileCommitted) outboxNotifier.off("file:committed", onFileCommitted);
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      },
    },
  },
});
