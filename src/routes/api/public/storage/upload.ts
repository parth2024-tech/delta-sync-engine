import { createFileRoute } from "@tanstack/react-router";
import { getStorageAdapter } from "../../../../../server/storage-adapter";

export const Route = createFileRoute("/api/public/storage/upload")({
  server: {
    handlers: {
      PUT: async ({ request }) => {
        const url = new URL(request.url);
        const key = url.searchParams.get("key");
        if (!key) {
          return new Response(JSON.stringify({ error: "Missing key parameter" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        try {
          const adapter = getStorageAdapter();
          const buffer = await request.arrayBuffer();
          await adapter.putObject(key, new Uint8Array(buffer));

          return new Response(null, { status: 200 });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return new Response(JSON.stringify({ error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
