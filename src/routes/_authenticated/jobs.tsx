import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, Fragment } from "react";
import { z } from "zod";
import { listSyncJobs } from "@/lib/sync.functions";

const jobSearchSchema = z.object({
  page: z.number().default(1).catch(1),
  status: z.enum(["all", "done", "error", "running"]).default("all").catch("all"),
});

export const Route = createFileRoute("/_authenticated/jobs")({
  head: () => ({ meta: [{ title: "Jobs | Deltasync" }] }),
  validateSearch: jobSearchSchema,
  component: JobsPage,
});

function fmt(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function JobsPage() {
  const { page, status: statusParam } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["sync-jobs", page, statusParam],
    queryFn: () => listSyncJobs({ data: { page, pageSize: 20, status: statusParam } }),
  });

  const jobs = data?.jobs ?? [];
  const totalCount = data?.totalCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / 20));

  function setStatusFilter(s: "all" | "done" | "error" | "running") {
    navigate({ search: { page: 1, status: s } });
  }

  function setPageNumber(p: number) {
    navigate({ search: { page: p, status: statusParam } });
  }

  function copyId(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(id).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <p className="mb-1 font-mono text-xs uppercase tracking-widest text-primary">
            // history
          </p>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">Sync Jobs</h1>
            <span className="rounded-full bg-secondary px-2.5 py-0.5 font-mono text-xs text-muted-foreground">
              {totalCount} total
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex rounded-md border border-border bg-card/40 p-0.5 text-xs font-mono">
            {(["all", "done", "error", "running"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`rounded px-2.5 py-1 uppercase tracking-wider transition-colors ${
                  statusParam === s
                    ? "bg-primary text-primary-foreground font-semibold"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <button
            onClick={() => refetch()}
            className="flex items-center gap-2 rounded-md border border-border bg-card/40 px-3 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                isFetching ? "bg-amber-400 animate-ping" : "bg-emerald-400"
              }`}
            />
            {isFetching ? "Syncing..." : "Refresh"}
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card/40">
        {isLoading ? (
          <div className="flex items-center justify-center h-48">
            <span className="font-mono text-sm text-muted-foreground animate-pulse">loading…</span>
          </div>
        ) : jobs.length === 0 ? (
          <div className="p-10 text-center">
            <p className="font-mono text-sm text-muted-foreground">
              {statusParam === "all"
                ? "No jobs recorded yet."
                : `No jobs with status "${statusParam}".`}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {["File", "Direction", "Transferred", "Saved", "Status", "Started", ""].map(
                    (h) => (
                      <th
                        key={h}
                        className="px-4 py-3 text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => {
                  const isExp = expanded === j.id;
                  return (
                    <Fragment key={j.id}>
                      <tr
                        className="border-b border-border/50 hover:bg-secondary/20 cursor-pointer transition-colors"
                        onClick={() => setExpanded(isExp ? null : j.id)}
                      >
                        <td className="px-4 py-3 font-mono text-xs text-primary max-w-xs truncate">
                          {j.filePath || "untitled"}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs uppercase text-muted-foreground">
                          {j.direction}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">
                          {fmt(Number(j.bytesTransferred))}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-amber-400">
                          {fmt(Number(j.bytesSaved))}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`font-mono text-[10px] rounded px-1.5 py-0.5 ${
                              j.status === "done"
                                ? "bg-emerald-500/20 text-emerald-400"
                                : j.status === "error"
                                  ? "bg-red-500/20 text-red-400"
                                  : "bg-cyan-500/20 text-cyan-400"
                            }`}
                          >
                            {j.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                          {new Date(j.startedAt!).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-muted-foreground text-right">
                          <svg
                            className={`inline-block h-4 w-4 transition-transform duration-200 ${
                              isExp ? "rotate-180" : ""
                            }`}
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M19 9l-7 7-7-7"
                            />
                          </svg>
                        </td>
                      </tr>
                      {isExp && (
                        <tr className="border-b border-border/30 bg-secondary/15">
                          <td colSpan={7} className="px-4 py-4">
                            <div className="font-mono text-xs space-y-2">
                              <div className="flex items-center gap-3">
                                <span className="text-muted-foreground">Job ID:</span>
                                <code>{j.id}</code>
                                <button
                                  onClick={(e) => copyId(j.id, e)}
                                  className="rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                                >
                                  {copiedId === j.id ? "✓ Copied" : "Copy ID"}
                                </button>
                              </div>
                              <p>
                                <span className="text-muted-foreground">Finished At:</span>{" "}
                                {j.finishedAt
                                  ? new Date(j.finishedAt).toLocaleString()
                                  : "Still running..."}
                              </p>
                              {j.error && (
                                <p className="text-red-400">
                                  <span className="font-semibold">Error Message:</span> {j.error}
                                </p>
                              )}
                              <p>
                                <span className="text-muted-foreground">
                                  Transfer Savings Ratio:
                                </span>{" "}
                                {Number(j.bytesTransferred) + Number(j.bytesSaved) > 0
                                  ? Math.round(
                                      (Number(j.bytesSaved) /
                                        (Number(j.bytesTransferred) + Number(j.bytesSaved))) *
                                        100,
                                    )
                                  : 0}
                                %
                              </p>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between font-mono text-xs">
        <span className="text-muted-foreground">
          Page {page} of {totalPages} ({totalCount} total jobs)
        </span>
        <div className="flex items-center gap-2">
          <button
            disabled={page <= 1}
            onClick={() => setPageNumber(page - 1)}
            className="rounded border border-border px-3 py-1 disabled:opacity-40 hover:bg-secondary"
          >
            ← prev
          </button>
          <button
            disabled={page >= totalPages}
            onClick={() => setPageNumber(page + 1)}
            className="rounded border border-border px-3 py-1 disabled:opacity-40 hover:bg-secondary"
          >
            next →
          </button>
        </div>
      </div>
    </div>
  );
}
