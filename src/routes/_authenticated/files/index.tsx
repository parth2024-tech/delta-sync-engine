import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { listFiles } from "@/lib/sync.functions";

export const Route = createFileRoute("/_authenticated/files/")({
  head: () => ({ meta: [{ title: "Files — Deltasync" }] }),
  component: FilesPage,
});

function fmt(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function FilesPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["files", page],
    queryFn:  () => listFiles({ data: { page, pageSize: 20 } }),
  });

  const filtered = (data ?? []).filter((f) =>
    !search || f.path.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <p className="mb-1 font-mono text-xs uppercase tracking-widest text-primary">// files</p>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-bold">Files</h1>
        <input
          value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by path…"
          className="rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary w-64"
        />
      </div>

      <div className="rounded-lg border border-border bg-card/40">
        {isLoading ? (
          <div className="flex items-center justify-center h-48">
            <span className="font-mono text-sm text-muted-foreground animate-pulse">loading…</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center">
            <p className="font-mono text-sm text-muted-foreground">No files yet. Push your first file using the CLI.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {["Path", "Size", "Last synced", ""].map((h) => (
                    <th key={h} className="px-4 py-3 text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((f) => (
                  <tr key={f.id} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="px-4 py-3 font-mono text-xs text-primary">{f.path}</td>
                    <td className="px-4 py-3 font-mono text-xs">{fmt(Number(f.totalSize))}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {new Date(f.createdAt!).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        to="/files/$fileId" params={{ fileId: f.id }}
                        className="font-mono text-xs text-primary hover:underline"
                      >
                        detail →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
          className="rounded border border-border px-3 py-1 font-mono text-xs disabled:opacity-40"
        >← prev</button>
        <span className="font-mono text-xs text-muted-foreground">page {page}</span>
        <button
          disabled={(data ?? []).length < 20}
          onClick={() => setPage((p) => p + 1)}
          className="rounded border border-border px-3 py-1 font-mono text-xs disabled:opacity-40"
        >next →</button>
      </div>
    </div>
  );
}
