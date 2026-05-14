import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getFileDetail, downloadVersion } from "@/lib/sync.functions";

export const Route = createFileRoute("/_authenticated/files/$fileId")({
  head: () => ({ meta: [{ title: "File Detail — Deltasync" }] }),
  component: FileDetail,
});

function fmt(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function BlockHeatmap({ blocks, prevStrongHashes }: {
  blocks: { blockIndex: number; strongHash: string }[];
  prevStrongHashes: Set<string>;
}) {
  if (blocks.length === 0) return null;
  const cols = Math.min(blocks.length, 32);
  return (
    <div className="flex flex-wrap gap-1 mt-2">
      {blocks.map((b) => {
        const reused = prevStrongHashes.has(b.strongHash);
        return (
          <div
            key={b.blockIndex}
            title={`Block ${b.blockIndex} — ${reused ? "reused" : "new"}`}
            className={`h-3 w-3 rounded-sm ${reused ? "bg-emerald-500/70" : "bg-amber-400/70"}`}
          />
        );
      })}
      <div className="w-full flex items-center gap-4 mt-1">
        <span className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
          <span className="h-2 w-2 rounded-sm bg-emerald-500/70" /> reused
        </span>
        <span className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
          <span className="h-2 w-2 rounded-sm bg-amber-400/70" /> new
        </span>
      </div>
    </div>
  );
}

function FileDetail() {
  const { fileId } = Route.useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ["file-detail", fileId],
    queryFn:  () => getFileDetail({ data: { fileId } }),
  });

  async function handleDownload(vId: string, filename: string) {
    const result = await downloadVersion({ data: { fileId, versionId: vId } });
    const bytes  = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0));
    const blob   = new Blob([bytes]);
    const url    = URL.createObjectURL(blob);
    const a      = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  if (isLoading) return <Shell><div className="flex items-center justify-center h-48"><span className="font-mono text-sm text-muted-foreground animate-pulse">loading…</span></div></Shell>;
  if (error || !data) return <Shell><p className="text-red-400 font-mono text-sm">File not found.</p></Shell>;

  const { file, versionBlocks } = data;

  return (
    <Shell>
      <div className="mb-6 rounded-lg border border-border bg-card/40 p-5">
        <p className="font-mono text-xs text-muted-foreground mb-1">path</p>
        <p className="font-mono text-lg font-semibold text-primary">{file.path}</p>
        <div className="mt-3 flex flex-wrap gap-6">
          <div><p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">size</p><p className="font-mono text-sm">{fmt(Number(file.totalSize))}</p></div>
          <div><p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">versions</p><p className="font-mono text-sm">{versionBlocks.length}</p></div>
          <div><p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">created</p><p className="font-mono text-sm">{new Date(file.createdAt!).toLocaleDateString()}</p></div>
        </div>
      </div>

      <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground mb-4">Version history</h2>

      <div className="relative border-l-2 border-border ml-3 space-y-6">
        {versionBlocks.map(({ version, blocks }, idx) => {
          const prevHashes = idx < versionBlocks.length - 1
            ? new Set(versionBlocks[idx + 1].blocks.map((b) => b.strongHash))
            : new Set<string>();

          return (
            <div key={version.id} className="relative pl-6">
              <div className="absolute -left-[9px] top-1 h-4 w-4 rounded-full border-2 border-primary bg-background" />
              <div className="rounded-lg border border-border bg-card/40 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <span className="font-mono text-sm font-bold text-foreground">v{version.versionNo}</span>
                    <span className="ml-3 font-mono text-xs text-muted-foreground">{fmt(Number(version.size))} · {version.totalBlocks} blocks · block size {version.blockSize}B</span>
                    <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/60 break-all">sha256: {version.contentSha256.slice(0, 32)}…</p>
                  </div>
                  <button
                    onClick={() => handleDownload(version.id, file.path.split("/").pop() ?? "file")}
                    className="shrink-0 rounded border border-border px-3 py-1 font-mono text-xs hover:bg-secondary"
                  >
                    ↓ download
                  </button>
                </div>
                <BlockHeatmap blocks={blocks} prevStrongHashes={prevHashes} />
              </div>
            </div>
          );
        })}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <div className="mb-6">
        <Link to="/files" className="font-mono text-xs text-muted-foreground hover:text-foreground">← files</Link>
      </div>
      <p className="mb-1 font-mono text-xs uppercase tracking-widest text-primary">// file detail</p>
      <h1 className="mb-6 text-3xl font-bold">File Detail</h1>
      {children}
    </div>
  );
}
