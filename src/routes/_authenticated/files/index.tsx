import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { listFiles } from "@/lib/sync.functions";

export const Route = createFileRoute("/_authenticated/files/")({
  head: () => ({ meta: [{ title: "Files | Deltasync" }] }),
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
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["files", page],
    queryFn: () => listFiles({ data: { page, pageSize: 20 } }),
    refetchInterval: 10000,
  });

  const files = data ?? [];
  const filtered = files.filter(
    (f) => !search || f.path.toLowerCase().includes(search.toLowerCase()),
  );

  function copyPath(path: string, e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(path).then(() => {
      setCopiedPath(path);
      setTimeout(() => setCopiedPath(null), 2000);
    });
  }

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="mb-1 font-mono text-xs uppercase tracking-widest text-primary">
            // storage
          </p>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">Files</h1>
            <span className="rounded-full bg-secondary px-2.5 py-0.5 font-mono text-xs text-muted-foreground">
              {files.length} active
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by path…"
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary w-64 pr-8"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            )}
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
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center">
            <p className="font-mono text-sm text-muted-foreground">
              {files.length === 0
                ? "No files yet. Push your first file using the CLI."
                : `No files matching "${search}".`}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {["Path", "Size", "Last Synced", "Actions"].map((h) => (
                    <th
                      key={h}
                      className="px-4 py-3 text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((f) => (
                  <tr
                    key={f.id}
                    className="border-b border-border/50 hover:bg-secondary/20 transition-colors"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-primary">
                      <div className="flex items-center gap-2">
                        <Link
                          to="/files/$fileId"
                          params={{ fileId: f.id }}
                          className="hover:underline font-semibold"
                        >
                          {f.path}
                        </Link>
                        <button
                          onClick={(e) => copyPath(f.path, e)}
                          title="Copy path"
                          className="text-[10px] text-muted-foreground hover:text-foreground opacity-60 hover:opacity-100"
                        >
                          {copiedPath === f.path ? "✓" : "copy"}
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{fmt(Number(f.totalSize))}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {new Date(f.createdAt!).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        to="/files/$fileId"
                        params={{ fileId: f.id }}
                        className="rounded border border-border px-2.5 py-1 font-mono text-xs text-primary transition-colors hover:bg-secondary hover:underline"
                      >
                        Inspect & Download →
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
          className="rounded border border-border px-3 py-1 font-mono text-xs disabled:opacity-40 hover:bg-secondary"
        >
          ← prev
        </button>
        <span className="font-mono text-xs text-muted-foreground">page {page}</span>
        <button
          disabled={files.length < 20}
          onClick={() => setPage((p) => p + 1)}
          className="rounded border border-border px-3 py-1 font-mono text-xs disabled:opacity-40 hover:bg-secondary"
        >
          next →
        </button>
      </div>
    </div>
  );
}
