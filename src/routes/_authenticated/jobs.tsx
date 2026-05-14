import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { listSyncJobs } from "@/lib/sync.functions";

export const Route = createFileRoute("/_authenticated/jobs")({
  head: () => ({ meta: [{ title: "Jobs — Deltasync" }] }),
  component: JobsPage,
});

function fmt(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function JobsPage() {
  const [page, setPage]         = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["sync-jobs", page],
    queryFn:  () => listSyncJobs({ data: { page, pageSize: 20 } }),
  });

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <p className="mb-1 font-mono text-xs uppercase tracking-widest text-primary">// history</p>
      <h1 className="mb-6 text-3xl font-bold">Sync Jobs</h1>

      <div className="rounded-lg border border-border bg-card/40">
        {isLoading ? (
          <div className="flex items-center justify-center h-48">
            <span className="font-mono text-sm text-muted-foreground animate-pulse">loading…</span>
          </div>
        ) : (data ?? []).length === 0 ? (
          <div className="p-10 text-center">
            <p className="font-mono text-sm text-muted-foreground">No jobs yet.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {["File", "Dir", "Transferred", "Saved", "Status", "Started", ""].map((h) => (
                    <th key={h} className="px-4 py-3 text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(data ?? []).map((j) => (
                  <>
                    <tr
                      key={j.id}
                      className="border-b border-border/50 hover:bg-secondary/20 cursor-pointer"
                      onClick={() => setExpanded(expanded === j.id ? null : j.id)}
                    >
                      <td className="px-4 py-3 font-mono text-xs text-primary max-w-xs truncate">{j.filePath ?? "—"}</td>
                      <td className="px-4 py-3 font-mono text-xs">{j.direction}</td>
                      <td className="px-4 py-3 font-mono text-xs">{fmt(Number(j.bytesTransferred))}</td>
                      <td className="px-4 py-3 font-mono text-xs text-amber-400">{fmt(Number(j.bytesSaved))}</td>
                      <td className="px-4 py-3">
                        <span className={`font-mono text-[10px] rounded px-1.5 py-0.5 ${
                          j.status === "done"  ? "bg-emerald-500/20 text-emerald-400" :
                          j.status === "error" ? "bg-red-500/20 text-red-400" :
                                                 "bg-amber-500/20 text-amber-400"}`}>
                          {j.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {new Date(j.startedAt!).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{expanded === j.id ? "▲" : "▼"}</td>
                    </tr>
                    {expanded === j.id && (
                      <tr key={j.id + "-exp"} className="border-b border-border/30 bg-secondary/10">
                        <td colSpan={7} className="px-4 py-3">
                          <div className="font-mono text-xs space-y-1">
                            <p><span className="text-muted-foreground">id:</span> {j.id}</p>
                            <p><span className="text-muted-foreground">finished:</span> {j.finishedAt ? new Date(j.finishedAt).toLocaleString() : "—"}</p>
                            {j.error && <p><span className="text-red-400">error:</span> {j.error}</p>}
                            <p>
                              <span className="text-muted-foreground">savings ratio:</span>{" "}
                              {Number(j.bytesTransferred) + Number(j.bytesSaved) > 0
                                ? Math.round((Number(j.bytesSaved) / (Number(j.bytesTransferred) + Number(j.bytesSaved))) * 100)
                                : 0}%
                            </p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded border border-border px-3 py-1 font-mono text-xs disabled:opacity-40">← prev</button>
        <span className="font-mono text-xs text-muted-foreground">page {page}</span>
        <button disabled={(data ?? []).length < 20} onClick={() => setPage((p) => p + 1)} className="rounded border border-border px-3 py-1 font-mono text-xs disabled:opacity-40">next →</button>
      </div>
    </div>
  );
}
