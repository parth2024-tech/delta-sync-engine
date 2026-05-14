import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { SiteHeader } from "@/components/site-header";
import {
  computeSignatures,
  computeDelta,
  applyDelta,
  DEFAULT_BLOCK_SIZE,
  type BlockSignature,
  type DeltaResult,
} from "@/lib/rsync";

export const Route = createFileRoute("/playground")({
  head: () => ({
    meta: [
      { title: "Playground — Deltasync" },
      { name: "description", content: "Run the rsync delta algorithm live in your browser. Compare two file versions and see exactly which blocks are reused." },
    ],
  }),
  component: Playground,
});

const SAMPLE_OLD = `# CHANGELOG

## v1.0.0
- Initial release of deltasync engine.
- Adler-32 rolling hash implementation.
- SHA-256 block verification.
- Fixed-size block segmentation at 1 KiB.

## Architecture
The system uses a two-level lookup table to find matching blocks
between the source and target file revisions.

## Performance
On a typical document with 1% changes, expect 95-99% bandwidth
savings versus a full re-upload.
`.padEnd(3072, " ");

const SAMPLE_NEW = `# CHANGELOG

## v1.1.0
- Added streaming delta reconstruction.
- Rolling hash now verified with SHA-256 on weak hits.
- Default block size remains 1 KiB; tunable per-file.
- Initial release of deltasync engine.
- Adler-32 rolling hash implementation.
- SHA-256 block verification.

## Architecture
The system uses a two-level lookup table to find matching blocks
between the source and target file revisions.

## Performance
On a typical document with 1% changes, expect 95-99% bandwidth
savings versus a full re-upload.
`.padEnd(3328, " ");

function Playground() {
  const [oldText, setOldText] = useState(SAMPLE_OLD);
  const [newText, setNewText] = useState(SAMPLE_NEW);
  const [blockSize, setBlockSize] = useState(DEFAULT_BLOCK_SIZE);
  const [running, setRunning] = useState(false);
  const [sigs, setSigs] = useState<BlockSignature[] | null>(null);
  const [result, setResult] = useState<DeltaResult | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);

  const oldBytes = useMemo(() => new TextEncoder().encode(oldText), [oldText]);
  const newBytes = useMemo(() => new TextEncoder().encode(newText), [newText]);

  const run = useCallback(async () => {
    setRunning(true);
    setVerified(null);
    try {
      const s = await computeSignatures(oldBytes, blockSize, "cdc");
      const r = await computeDelta(newBytes, s, blockSize, "cdc");
      // Sanity: reconstruct and compare.
      const reconstructed = applyDelta(oldBytes, s, r.ops, newBytes.length);
      const ok =
        reconstructed.length === newBytes.length &&
        reconstructed.every((b, i) => b === newBytes[i]);
      setSigs(s);
      setResult(r);
      setVerified(ok);
    } finally {
      setRunning(false);
    }
  }, [oldBytes, newBytes, blockSize]);

  const loadFile = (which: "old" | "new") => async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 256 * 1024) {
      alert("Demo capped at 256 KiB. Use the CLI for larger files.");
      return;
    }
    const text = await file.text();
    if (which === "old") setOldText(text);
    else setNewText(text);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <div className="mx-auto max-w-7xl px-6 py-10">
        <p className="mb-2 font-mono text-xs uppercase tracking-widest text-primary">
          // live in-browser demo
        </p>
        <h1 className="mb-2 font-display text-3xl font-bold">Delta playground</h1>
        <p className="mb-8 max-w-2xl text-muted-foreground">
          Edit the two file versions below (or upload your own). The full rsync
          algorithm runs in your browser — Adler-32 rolling hash, SHA-256 verify,
          delta op generation, and byte-perfect reconstruction.
        </p>

        <div className="mb-6 flex flex-wrap items-end gap-4 rounded-lg border border-border bg-card/40 p-4">
          <div>
            <label className="mb-1 block font-mono text-xs uppercase tracking-widest text-muted-foreground">
              block size
            </label>
            <select
              value={blockSize}
              onChange={(e) => setBlockSize(Number(e.target.value))}
              className="rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
            >
              <option value={64}>64 B</option>
              <option value={128}>128 B</option>
              <option value={256}>256 B</option>
              <option value={512}>512 B</option>
              <option value={1024}>1 KiB</option>
              <option value={2048}>2 KiB</option>
            </select>
          </div>
          <button
            onClick={run}
            disabled={running}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2 font-mono text-sm font-semibold text-primary-foreground shadow-glow transition-transform hover:-translate-y-0.5 disabled:opacity-50"
          >
            {running ? "computing…" : "▸ compute delta"}
          </button>
          {verified !== null && (
            <span
              className={
                "font-mono text-xs " +
                (verified ? "text-reuse" : "text-destructive")
              }
            >
              {verified ? "● reconstruction verified byte-for-byte" : "● reconstruction MISMATCH"}
            </span>
          )}
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <FileEditor
            label="old version (server has this)"
            value={oldText}
            onChange={setOldText}
            onUpload={loadFile("old")}
            byteLen={oldBytes.length}
          />
          <FileEditor
            label="new version (client wants to upload)"
            value={newText}
            onChange={setNewText}
            onUpload={loadFile("new")}
            byteLen={newBytes.length}
          />
        </div>

        {result && sigs && (
          <Results result={result} sigs={sigs} newSize={newBytes.length} />
        )}
      </div>
    </div>
  );
}

function FileEditor({
  label,
  value,
  onChange,
  onUpload,
  byteLen,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  byteLen: number;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/40">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <span className="font-mono text-xs text-muted-foreground">{label}</span>
        <div className="flex items-center gap-3 font-mono text-xs">
          <span className="text-muted-foreground">{byteLen.toLocaleString()} B</span>
          <label className="cursor-pointer text-primary hover:underline">
            upload
            <input type="file" className="hidden" onChange={onUpload} />
          </label>
        </div>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-72 w-full resize-none bg-transparent p-4 font-mono text-xs leading-relaxed text-foreground outline-none"
        spellCheck={false}
      />
    </div>
  );
}

function Results({
  result,
  sigs,
  newSize,
}: {
  result: DeltaResult;
  sigs: BlockSignature[];
  newSize: number;
}) {
  const { stats, ops, blockSize } = result;
  const fullUploadBytes = newSize;
  const deltaBytes = stats.literalBytes + ops.filter((o) => o.type === "copy").length * 8; // 8B copy ref overhead
  const savedPct = fullUploadBytes
    ? ((1 - deltaBytes / fullUploadBytes) * 100).toFixed(2)
    : "0";

  return (
    <div className="mt-8 space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="bandwidth saved" value={`${savedPct}%`} accent />
        <Stat label="bytes transferred" value={deltaBytes.toLocaleString()} />
        <Stat label="blocks reused" value={`${stats.reusedBlocks} / ${sigs.length}`} />
        <Stat label="literal runs" value={String(stats.newLiteralRuns)} />
      </div>

      {/* Block reuse heatmap (new file's perspective) */}
      <div className="rounded-lg border border-border bg-card/40 p-5">
        <div className="mb-3 flex items-center justify-between">
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            new file · block reuse map
          </span>
          <div className="flex items-center gap-4 font-mono text-[10px] uppercase tracking-widest">
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-reuse" /> reused (copy)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-literal" /> new bytes (literal)
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {ops.map((op, i) => {
            const isCopy = op.type === "copy";
            const cells = Math.max(1, Math.ceil((isCopy ? op.length : op.bytes.length) / Math.max(64, blockSize / 16)));
            return Array.from({ length: cells }).map((_, j) => (
              <span
                key={`${i}-${j}`}
                title={
                  isCopy
                    ? `COPY block #${op.blockIndex} (${op.length} B)`
                    : `LITERAL ${op.bytes.length} B`
                }
                className={
                  "h-5 w-5 rounded-sm transition-transform hover:scale-125 " +
                  (isCopy ? "bg-reuse/80" : "bg-literal/80")
                }
              />
            ));
          })}
        </div>
      </div>

      {/* Op stream */}
      <div className="rounded-lg border border-border bg-card/40">
        <div className="border-b border-border px-4 py-2 font-mono text-xs uppercase tracking-widest text-muted-foreground">
          delta op stream ({ops.length} ops)
        </div>
        <div className="max-h-72 overflow-auto p-4 font-mono text-xs leading-relaxed">
          {ops.map((op, i) => (
            <div key={i} className="flex gap-4">
              <span className="w-8 text-muted-foreground">{i.toString().padStart(3, "0")}</span>
              {op.type === "copy" ? (
                <span className="text-reuse">
                  COPY    block=#{op.blockIndex.toString().padStart(4, "0")}  len={op.length}  → @{op.offset}
                </span>
              ) : (
                <span className="text-literal">
                  LITERAL bytes={op.bytes.length.toString().padStart(4, " ")}                → @{op.offset}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-5">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div
        className={
          "mt-2 font-display text-2xl font-bold " +
          (accent ? "text-primary" : "text-foreground")
        }
      >
        {value}
      </div>
    </div>
  );
}
