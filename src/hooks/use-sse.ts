import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

export function useSSE() {
  const qc = useQueryClient();
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    function connect() {
      if (esRef.current) return;
      try {
        const es = new EventSource("/api/events");
        esRef.current = es;

        es.addEventListener("job:status", () => {
          qc.invalidateQueries({ queryKey: ["sync-jobs"] });
          qc.invalidateQueries({ queryKey: ["dashboard-stats"] });
        });

        es.addEventListener("file:committed", () => {
          qc.invalidateQueries({ queryKey: ["files"] });
          qc.invalidateQueries({ queryKey: ["dashboard-stats"] });
        });

        es.onerror = () => {
          // If disconnected or error, close and allow reconnect on focus
          if (esRef.current) {
            esRef.current.close();
            esRef.current = null;
          }
        };
      } catch {
        // SSE not supported or network blocked
      }
    }

    connect();

    function handleVisibility() {
      if (document.visibilityState === "hidden") {
        if (esRef.current) {
          esRef.current.close();
          esRef.current = null;
        }
      } else if (document.visibilityState === "visible") {
        connect();
        // Immediately refresh active data on tab focus
        qc.invalidateQueries({ queryKey: ["dashboard-stats"] });
        qc.invalidateQueries({ queryKey: ["sync-jobs"] });
        qc.invalidateQueries({ queryKey: ["files"] });
      }
    }

    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [qc]);
}
