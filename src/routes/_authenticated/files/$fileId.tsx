import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getFileDetail, rollbackToVersion } from "@/lib/sync.functions";

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

interface BlockData {
  blockIndex: number;
  weakHash: number;
  strongHash: string;
  offset: number;
  length: number;
}

function BlockHeatmap({
  blocks,
  prevStrongHashes,
  blockSize,
}: {
  blocks: BlockData[];
  prevStrongHashes: Set<string>;
  blockSize: number;
}) {
  if (blocks.length === 0) return null;

  const total = blocks.length;
  const reused = blocks.filter((b) => prevStrongHashes.has(b.strongHash)).length;
  const newlyCreated = total - reused;
  const dedupPct = total > 0 ? Math.round((reused / total) * 100) : 0;
  const estimatedSaved = reused * blockSize;

  return (
    <div className="mt-4 space-y-2 border-t border-border/40 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-emerald-400">
            <span className="h-2.5 w-2.5 rounded-sm bg-emerald-500/70" />
            {reused} reused ({dedupPct}%)
          </span>
          <span className="flex items-center gap-1.5 text-amber-400">
            <span className="h-2.5 w-2.5 rounded-sm bg-amber-400/70" />
            {newlyCreated} new
          </span>
        </div>
        {reused > 0 && (
          <span className="text-muted-foreground">
            Deduplicated: <strong className="text-foreground">{fmt(estimatedSaved)}</strong>
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-1 max-h-48 overflow-y-auto p-1 rounded bg-background/50 border border-border/30">
        {blocks.map((b) => {
          const isReused = prevStrongHashes.has(b.strongHash);
          return (
            <div
              key={b.blockIndex}
              title={`Block #${b.blockIndex} (${isReused ? "reused" : "new"})\nOffset: ${b.offset} | Len: ${b.length}B\nHash: ${b.strongHash.slice(0, 16)}…`}
              className={`h-4 w-4 rounded-sm transition-transform hover:scale-125 cursor-help ${
                isReused
                  ? "bg-emerald-500/70 hover:bg-emerald-400"
                  : "bg-amber-400/70 hover:bg-amber-300"
              }`}
            />
          );
        })}
      </div>
    </div>
  );
}

function FileDetail() {
  const { fileId } = Route.useParams();
  const qc = useQueryClient();
  const [copiedSha, setCopiedSha] = useState<string | null>(null);
  const [confirmRollbackId, setConfirmRollbackId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["file-detail", fileId],
    queryFn: () => getFileDetail({ data: { fileId } }),
  });

  const rollbackMut = useMutation({
    mutationFn: (versionId: string) => rollbackToVersion({ data: { fileId, versionId } }),
    onSuccess: () => {
      setConfirmRollbackId(null);
      qc.invalidateQueries({ queryKey: ["file-detail", fileId] });
      qc.invalidateQueries({ queryKey: ["files"] });
      qc.invalidateQueries({ queryKey: ["sync-jobs"] });
    },
  });

  function handleNativeDownload(versionId: string) {
    const url = `/api/files/download?fileId=${encodeURIComponent(fileId)}&versionId=${encodeURIComponent(versionId)}`;
    window.location.assign(url);
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
        Version history & Chunk Diff Map
      </h2>

      <div className="relative border-l-2 border-border ml-3 space-y-6">
        {versionBlocks.map(({ version, blocks }, idx) => {
          const isLatest = idx === 0;
          const prevHashes =
            idx < versionBlocks.length - 1
              ? new Set(versionBlocks[idx + 1].blocks.map((b) => b.strongHash))
              : new Set<string>();

          return (
            <div key={version.id} className="relative pl-6">
              <div
                className={`absolute -left-[9px] top-1 h-4 w-4 rounded-full border-2 ${
                  isLatest ? "border-primary bg-primary" : "border-muted-foreground bg-background"
                }`}
              />
              <div className="rounded-lg border border-border bg-card/40 p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-bold text-foreground">
                        v{version.versionNo}
                      </span>
                      {isLatest && (
                        <span className="rounded bg-primary/20 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary">
                          latest
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-xs text-muted-foreground">
                      {fmt(Number(version.size))} · {version.totalBlocks} blocks ·{" "}
                      {version.blockSize}B chunk size
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

                  <div className="flex items-center gap-2">
                    {!isLatest &&
                      (confirmRollbackId === version.id ? (
                        <div className="flex items-center gap-1 font-mono text-xs">
                          <span className="text-amber-400">Restore?</span>
                          <button
                            disabled={rollbackMut.isPending}
                            onClick={() => rollbackMut.mutate(version.id)}
                            className="rounded bg-primary px-2 py-1 text-primary-foreground font-semibold hover:bg-primary/90"
                          >
                            {rollbackMut.isPending ? "…" : "Confirm"}
                          </button>
                          <button
                            onClick={() => setConfirmRollbackId(null)}
                            className="rounded border border-border px-2 py-1 hover:bg-secondary"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmRollbackId(version.id)}
                          className="rounded border border-border px-3 py-1 font-mono text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
                        >
                          ↺ Rollback to v{version.versionNo}
                        </button>
                      ))}
                    <button
                      onClick={() => handleNativeDownload(version.id)}
                      className="rounded border border-border bg-card px-3 py-1 font-mono text-xs font-semibold text-primary hover:bg-secondary"
                    >
                      ↓ Stream Download
                    </button>
                  </div>
                </div>

                <BlockHeatmap
                  blocks={blocks}
                  prevStrongHashes={prevHashes}
                  blockSize={version.blockSize}
                />
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
