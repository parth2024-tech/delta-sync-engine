import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getFileDetail, downloadVersion } from "@/lib/sync.functions";

export const Route = createFileRoute("/_authenticated/files/$fileId")({
  head: () => ({ meta: [{ title: "File Detail | Deltasync" }] }),
  component: FileDetail,
});

function fmt(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function BlockHeatmap({
  blocks,
  prevStrongHashes,
}: {
  blocks: { blockIndex: number; strongHash: string }[];
  prevStrongHashes: Set<string>;
}) {
  if (blocks.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-2">
      {blocks.map((b) => {
        const reused = prevStrongHashes.has(b.strongHash);
        return (
          <div
            key={b.blockIndex}
            title={`Block ${b.blockIndex} (${reused ? "reused" : "new"})`}
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
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [copiedSha, setCopiedSha] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["file-detail", fileId],
    queryFn: () => getFileDetail({ data: { fileId } }),
  });

  async function handleDownload(vId: string, filename: string) {
    setDownloadingId(vId);
    try {
      const result = await downloadVersion({ data: { fileId, versionId: vId } });
      const binary = atob(result.data);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([bytes]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Download failed:", err);
      alert("Download failed. Check server logs.");
    } finally {
      setDownloadingId(null);
    }
  }

  function copySha(sha: string, vId: string) {
    navigator.clipboard.writeText(sha).then(() => {
      setCopiedSha(vId);
      setTimeout(() => setCopiedSha(null), 2000);
    });
  }

  if (isLoading)
    return (
      <Shell>
        <div className="flex items-center justify-center h-48">
          <span className="font-mono text-sm text-muted-foreground animate-pulse">loading…</span>
        </div>
      </Shell>
    );
  if (error || !data)
    return (
      <Shell>
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-6 font-mono text-sm">
          <p className="text-red-400 font-semibold">File record not found.</p>
          <Link to="/files" className="mt-3 inline-block text-xs text-primary hover:underline">
            ← Return to file catalog
          </Link>
        </div>
      </Shell>
    );

  const { file, versionBlocks } = data;

  return (
    <Shell>
      <div className="mb-6 rounded-lg border border-border bg-card/40 p-5">
        <p className="font-mono text-xs text-muted-foreground mb-1">path</p>
        <p className="font-mono text-lg font-semibold text-primary">{file.path}</p>
        <div className="mt-3 flex flex-wrap gap-6">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              size
            </p>
            <p className="font-mono text-sm">{fmt(Number(file.totalSize))}</p>
          </div>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              versions
            </p>
            <p className="font-mono text-sm">{versionBlocks.length}</p>
          </div>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              created
            </p>
            <p className="font-mono text-sm">{new Date(file.createdAt!).toLocaleDateString()}</p>
          </div>
        </div>
      </div>

      <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground mb-4">
        Version history
      </h2>

      <div className="relative border-l-2 border-border ml-3 space-y-6">
        {versionBlocks.map(({ version, blocks }, idx) => {
          const prevHashes =
            idx < versionBlocks.length - 1
              ? new Set(versionBlocks[idx + 1].blocks.map((b) => b.strongHash))
              : new Set<string>();

          const isDownloading = downloadingId === version.id;

          return (
            <div key={version.id} className="relative pl-6">
              <div className="absolute -left-[9px] top-1 h-4 w-4 rounded-full border-2 border-primary bg-background" />
              <div className="rounded-lg border border-border bg-card/40 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <span className="font-mono text-sm font-bold text-foreground">
                      v{version.versionNo}
                    </span>
                    <span className="ml-3 font-mono text-xs text-muted-foreground">
                      {fmt(Number(version.size))} · {version.totalBlocks} blocks · block size{" "}
                      {version.blockSize}B
                    </span>
                    <div className="mt-1 flex items-center gap-2">
                      <p className="font-mono text-[10px] text-muted-foreground/80 break-all">
                        sha256: {version.contentSha256.slice(0, 32)}…
                      </p>
                      <button
                        onClick={() => copySha(version.contentSha256, version.id)}
                        className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                      >
                        {copiedSha === version.id ? "✓ copied" : "copy hash"}
                      </button>
                    </div>
                  </div>
                  <button
                    disabled={isDownloading}
                    onClick={() => handleDownload(version.id, file.path.split("/").pop() ?? "file")}
                    className="shrink-0 rounded border border-border px-3 py-1 font-mono text-xs hover:bg-secondary disabled:opacity-50"
                  >
                    {isDownloading ? "↓ downloading…" : "↓ download"}
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
        <Link to="/files" className="font-mono text-xs text-muted-foreground hover:text-foreground">
          ← Return to files
        </Link>
      </div>
      <p className="mb-1 font-mono text-xs uppercase tracking-widest text-primary">
        // file detail
      </p>
      <h1 className="mb-6 text-3xl font-bold">File Detail</h1>
      {children}
    </div>
  );
}
