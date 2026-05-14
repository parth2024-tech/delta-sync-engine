import { createFileRoute } from "@tanstack/react-router";
import { sql } from "drizzle-orm";
import { db } from "../../../server/db";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        try {
          await db.execute(sql`SELECT 1`);
          return new Response("OK", { status: 200 });
        } catch (error) {
          console.error("Health probe failed:", error);
          return new Response("Service Unavailable", { status: 503 });
        }
      },
    },
  },
});
