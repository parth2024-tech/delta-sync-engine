import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useRef } from "react";
import { z } from "zod";
import { listFiles } from "@/lib/sync.functions";

const fileSearchSchema = z.object({
  page: z.number().default(1).catch(1),
  q: z.string().default("").catch(""),
});

export const Route = createFileRoute("/_authenticated/files/")({
  head: () => ({ meta: [{ title: "Files | Deltasync" }] }),
  validateSearch: fileSearchSchema,
  component: FilesPage,
});

function fmt(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

interface UploadProgress {
  fileName: string;
  totalBytes: number;
  chunksProcessed: number;
  totalChunks: number;
  bytesHashed: number;
  status: "hashing" | "done" | "error";
  contentSha256?: string;
  chunksCount?: number;
}

function FilesPage() {
  const { page, q } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const qc = useQueryClient();

  const [searchInput, setSearchInput] = useState(q);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadState, setUploadState] = useState<UploadProgress | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const workerRef = useRef<Worker | null>(null);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["files", page, q],
    queryFn: () => listFiles({ data: { page, pageSize: 20, search: q } }),
  });

  const files = data?.files ?? [];
  const totalCount = data?.totalCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / 20));

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    navigate({ search: { page: 1, q: searchInput } });
  }

  function handleClearSearch() {
    setSearchInput("");
    navigate({ search: { page: 1, q: "" } });
  }

  function setPageNumber(p: number) {
    navigate({ search: { page: p, q } });
  }

  function copyPath(path: string, e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(path).then(() => {
      setCopiedPath(path);
      setTimeout(() => setCopiedPath(null), 2000);
    });
  }

  function processFileWithWorker(file: File) {
    if (workerRef.current) {
      workerRef.current.terminate();
    }

    setUploadState({
      fileName: file.name,
      totalBytes: file.size,
      chunksProcessed: 0,
      totalChunks: 1,
      bytesHashed: 0,
      status: "hashing",
    });

    const reader = new FileReader();
    reader.onload = () => {
      const arrayBuffer = reader.result as ArrayBuffer;
      const worker = new Worker("/upload-worker.js");
      workerRef.current = worker;

      worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === "progress") {
          setUploadState((prev) =>
            prev
              ? {
                  ...prev,
                  chunksProcessed: msg.chunksProcessed,
                  totalChunks: msg.totalChunks,
                  bytesHashed: msg.bytesHashed,
                }
              : null,
          );
        } else if (msg.type === "done") {
          setUploadState((prev) =>
            prev
              ? {
                  ...prev,
                  status: "done",
                  chunksCount: msg.chunks.length,
                  contentSha256: msg.contentSha256,
                  bytesHashed: prev.totalBytes,
                  chunksProcessed: msg.chunks.length,
                  totalChunks: msg.chunks.length,
                }
              : null,
          );
        }
      };

      worker.onerror = () => {
        setUploadState((prev) => (prev ? { ...prev, status: "error" } : null));
      };

      worker.postMessage({
        fileData: arrayBuffer,
        fileName: file.name,
        opts: { minSize: 2048, avgSize: 4096, maxSize: 16384 },
      });
    };

    reader.readAsArrayBuffer(file);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile) {
      processFileWithWorker(droppedFile);
    }
  }

  function cancelUpload() {
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    setUploadState(null);
  }

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      {/* Top Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="mb-1 font-mono text-xs uppercase tracking-widest text-primary">
            // storage
          </p>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">Files</h1>
            <span className="rounded-full bg-secondary px-2.5 py-0.5 font-mono text-xs text-muted-foreground">
              {totalCount} total
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <form onSubmit={handleSearchSubmit} className="relative">
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Filter by path…"
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary w-64 pr-8 font-mono text-xs"
            />
            {searchInput && (
              <button
                type="button"
                onClick={handleClearSearch}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            )}
          </form>
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

      {/* Drag & Drop Upload Zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`mb-6 flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
          isDragging
            ? "border-primary bg-primary/10"
            : "border-border/80 bg-card/20 hover:border-primary/50 hover:bg-card/40"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) processFileWithWorker(f);
          }}
        />
        <div className="font-mono text-xs text-muted-foreground">
          <span className="font-semibold text-primary">Drop any file here</span> or click to upload
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground/70">
          Zero-copy FastCDC chunking and SHA-256 verification offloaded to client-side Web Worker
        </p>
      </div>

      {/* Active Worker Upload Modal / Progress Card */}
      {uploadState && (
        <div className="mb-6 rounded-lg border border-primary/40 bg-card/60 p-5 shadow-lg">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse" />
              <span className="font-mono text-xs font-semibold text-foreground">
                {uploadState.fileName}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                ({fmt(uploadState.totalBytes)})
              </span>
            </div>
            <button
              onClick={cancelUpload}
              className="font-mono text-xs text-muted-foreground hover:text-foreground"
            >
              ✕ cancel
            </button>
          </div>

          <div className="h-2 w-full rounded-full bg-secondary overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-150"
              style={{
                width: `${
                  uploadState.totalBytes > 0
                    ? Math.min(
                        100,
                        Math.round((uploadState.bytesHashed / uploadState.totalBytes) * 100),
                      )
                    : 0
                }%`,
              }}
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 font-mono text-xs text-muted-foreground">
            <div>
              {uploadState.status === "hashing" ? (
                <span>
                  Chunking & Hashing: {uploadState.chunksProcessed} / {uploadState.totalChunks}{" "}
                  chunks ({fmt(uploadState.bytesHashed)})
                </span>
              ) : uploadState.status === "done" ? (
                <span className="text-emerald-400 font-semibold">
                  ✓ Verified: {uploadState.chunksCount} FastCDC chunks · SHA-256:{" "}
                  {uploadState.contentSha256?.slice(0, 16)}…
                </span>
              ) : (
                <span className="text-red-400">Worker error during processing</span>
              )}
            </div>

            {uploadState.status === "done" && (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-primary">
                  Ready for delta sync · Use CLI to push with zero re-upload
                </span>
                <button
                  onClick={() => {
                    qc.invalidateQueries({ queryKey: ["files"] });
                    setUploadState(null);
                  }}
                  className="rounded bg-primary px-3 py-1 text-primary-foreground font-semibold hover:bg-primary/90"
                >
                  Done
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Files Table */}
      <div className="rounded-lg border border-border bg-card/40">
        {isLoading ? (
          <div className="flex items-center justify-center h-48">
            <span className="font-mono text-sm text-muted-foreground animate-pulse">loading…</span>
          </div>
        ) : files.length === 0 ? (
          <div className="p-10 text-center">
            <p className="font-mono text-sm text-muted-foreground">
              {q
                ? `No files matching "${q}".`
                : "No files yet. Drop a file above or push using the CLI."}
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
                {files.map((f) => (
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
                      <div className="inline-flex items-center gap-2">
                        {f.currentVersionId && (
                          <a
                            href={`/api/files/download?fileId=${encodeURIComponent(f.id)}&versionId=${encodeURIComponent(f.currentVersionId)}`}
                            className="rounded border border-border px-2.5 py-1 font-mono text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
                            title="Native Stream Download"
                          >
                            ↓ Stream
                          </a>
                        )}
                        <Link
                          to="/files/$fileId"
                          params={{ fileId: f.id }}
                          className="rounded border border-border px-2.5 py-1 font-mono text-xs text-primary transition-colors hover:bg-secondary hover:underline"
                        >
                          Detail & Diff →
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination Footer */}
      <div className="mt-4 flex items-center justify-between font-mono text-xs">
        <span className="text-muted-foreground">
          Page {page} of {totalPages} ({totalCount} total files)
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
