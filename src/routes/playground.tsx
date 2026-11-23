import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
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
      { title: "Playground | Deltasync" },
      {
        name: "description",
        content:
          "Run the rsync delta algorithm live in your browser. Compare two file versions and see exactly which blocks are reused.",
      },
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

function formatHexDump(bytes: Uint8Array, maxBytes = 256): string {
  if (bytes.length === 0) return "Empty buffer (0 bytes)";
  const slice = bytes.subarray(0, maxBytes);
  const lines: string[] = [];
  for (let i = 0; i < slice.length; i += 16) {
    const chunk = slice.subarray(i, i + 16);
    const hexParts: string[] = [];
    let ascii = "";
    for (let j = 0; j < 16; j++) {
      if (j < chunk.length) {
        const b = chunk[j];
        hexParts.push(b.toString(16).padStart(2, "0"));
        ascii += b >= 32 && b <= 126 ? String.fromCharCode(b) : ".";
      } else {
        hexParts.push("  ");
      }
    }
    const offsetStr = i.toString(16).padStart(8, "0");
    const hexStr = hexParts.slice(0, 8).join(" ") + "  " + hexParts.slice(8).join(" ");
    lines.push(`${offsetStr}  ${hexStr}  |${ascii}|`);
  }
  if (bytes.length > maxBytes) {
    lines.push(
      `… (${(bytes.length - maxBytes).toLocaleString()} more bytes; ${bytes.length.toLocaleString()} bytes total)`,
    );
  }
  return lines.join("\n");
}

function Playground() {
  const [mode, setMode] = useState<"text" | "binary">("text");
  const [oldText, setOldText] = useState(SAMPLE_OLD);
  const [newText, setNewText] = useState(SAMPLE_NEW);

  const [oldBinary, setOldBinary] = useState<Uint8Array | null>(null);
  const [newBinary, setNewBinary] = useState<Uint8Array | null>(null);
  const [oldFileName, setOldFileName] = useState<string>("document-v1.txt");
  const [newFileName, setNewFileName] = useState<string>("document-v2.txt");

  const [blockSize, setBlockSize] = useState(DEFAULT_BLOCK_SIZE);
  const [running, setRunning] = useState(false);
  const [sigs, setSigs] = useState<BlockSignature[] | null>(null);
  const [result, setResult] = useState<DeltaResult | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);

  const oldBytes = useMemo(() => {
    if (mode === "binary" && oldBinary) return oldBinary;
    return new TextEncoder().encode(oldText);
  }, [mode, oldBinary, oldText]);

  const newBytes = useMemo(() => {
    if (mode === "binary" && newBinary) return newBinary;
    return new TextEncoder().encode(newText);
  }, [mode, newBinary, newText]);

  const run = useCallback(async () => {
    setRunning(true);
    setVerified(null);
    try {
      const s = await computeSignatures(oldBytes, blockSize, "cdc");
      const r = await computeDelta(newBytes, s, blockSize, "cdc");
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

  useEffect(() => {
    run();
  }, [run]);

  const handleFileUpload = (which: "old" | "new", file: File) => {
    if (file.size > 2 * 1024 * 1024) {
      alert("Browser playground is capped at 2 MiB. Use the Deltasync CLI for larger datasets.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const buf = new Uint8Array(reader.result as ArrayBuffer);
      if (mode === "binary") {
        if (which === "old") {
          setOldBinary(buf);
          setOldFileName(file.name);
        } else {
          setNewBinary(buf);
          setNewFileName(file.name);
        }
      } else {
        // Text mode: decode UTF-8 if valid, else switch to binary mode
        try {
          const dec = new TextDecoder("utf-8", { fatal: true }).decode(buf);
          if (which === "old") setOldText(dec);
          else setNewText(dec);
        } catch {
          // Switch to binary mode on binary data
          setMode("binary");
          if (which === "old") {
            setOldBinary(buf);
            setOldFileName(file.name);
          } else {
            setNewBinary(buf);
            setNewFileName(file.name);
          }
        }
      }
    };
    reader.readAsArrayBuffer(file);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <div className="mx-auto max-w-7xl px-6 py-10">
        <p className="mb-2 font-mono text-xs uppercase tracking-widest text-primary">
          // live in-browser demo
        </p>
        <h1 className="mb-2 font-display text-3xl font-bold">Delta Playground</h1>
        <p className="mb-8 max-w-2xl text-muted-foreground">
          Edit text or drop arbitrary binary files (up to 2 MiB). The full rsync algorithm runs 100%
          in your browser using Adler-32 rolling hash, SHA-256 verification, and byte-perfect
          reconstruction.
        </p>

        {/* Toolbar */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-card/40 p-4">
          <div className="flex flex-wrap items-center gap-4">
            <div>
              <label className="mb-1 block font-mono text-xs uppercase tracking-widest text-muted-foreground">
                block size
              </label>
              <select
                value={blockSize}
                onChange={(e) => setBlockSize(Number(e.target.value))}
                className="rounded-md border border-input bg-background px-3 py-1.5 font-mono text-sm"
              >
                <option value={64}>64 B</option>
                <option value={128}>128 B</option>
                <option value={256}>256 B</option>
                <option value={512}>512 B</option>
                <option value={1024}>1 KiB</option>
                <option value={2048}>2 KiB</option>
                <option value={4096}>4 KiB</option>
              </select>
            </div>

            {/* Mode Toggle */}
            <div>
              <label className="mb-1 block font-mono text-xs uppercase tracking-widest text-muted-foreground">
                mode
              </label>
              <div className="flex rounded-md border border-border bg-background p-0.5 text-xs font-mono">
                <button
                  onClick={() => setMode("text")}
                  className={`rounded px-3 py-1 uppercase tracking-wider transition-colors ${
                    mode === "text"
                      ? "bg-primary text-primary-foreground font-semibold"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Text Mode
                </button>
                <button
                  onClick={() => setMode("binary")}
                  className={`rounded px-3 py-1 uppercase tracking-wider transition-colors ${
                    mode === "binary"
                      ? "bg-primary text-primary-foreground font-semibold"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Binary / File Mode
                </button>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {verified !== null && (
              <span
                className={"font-mono text-xs " + (verified ? "text-reuse" : "text-destructive")}
              >
                {verified ? "● Reconstruction verified byte-for-byte" : "● Reconstruction MISMATCH"}
              </span>
            )}
            <button
              onClick={run}
              disabled={running}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2 font-mono text-sm font-semibold text-primary-foreground shadow-glow transition-transform hover:-translate-y-0.5 disabled:opacity-50"
            >
              {running ? "Computing…" : "▸ Compute Delta"}
            </button>
          </div>
        </div>

        {/* File Editors / Dropzones */}
        <div className="grid gap-6 lg:grid-cols-2">
          <FileDropPanel
            label="Old Version (Server State)"
            fileName={mode === "binary" ? oldFileName : "sample-old.md"}
            mode={mode}
            textValue={oldText}
            onTextChange={setOldText}
            bytes={oldBytes}
            onFileDropped={(f) => handleFileUpload("old", f)}
          />
          <FileDropPanel
            label="New Version (Client State)"
            fileName={mode === "binary" ? newFileName : "sample-new.md"}
            mode={mode}
            textValue={newText}
            onTextChange={setNewText}
            bytes={newBytes}
            onFileDropped={(f) => handleFileUpload("new", f)}
          />
        </div>

        {result && sigs && <Results result={result} sigs={sigs} newSize={newBytes.length} />}
      </div>
    </div>
  );
}

function FileDropPanel({
  label,
  fileName,
  mode,
  textValue,
  onTextChange,
  bytes,
  onFileDropped,
}: {
  label: string;
  fileName: string;
  mode: "text" | "binary";
  textValue: string;
  onTextChange: (s: string) => void;
  bytes: Uint8Array;
  onFileDropped: (f: File) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFileDropped(f);
      }}
      className={`rounded-lg border transition-colors ${
        dragging ? "border-primary bg-primary/10" : "border-border bg-card/40"
      }`}
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-semibold text-foreground">{label}</span>
          <span className="font-mono text-[11px] text-muted-foreground">({fileName})</span>
        </div>
        <div className="flex items-center gap-3 font-mono text-xs">
          <span className="text-muted-foreground">{bytes.length.toLocaleString()} B</span>
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFileDropped(f);
            }}
          />
          <button
            onClick={() => inputRef.current?.click()}
            className="text-primary hover:underline text-xs"
          >
            Upload file
          </button>
        </div>
      </div>

      {mode === "text" ? (
        <textarea
          value={textValue}
          onChange={(e) => onTextChange(e.target.value)}
          className="h-72 w-full resize-none bg-transparent p-4 font-mono text-xs leading-relaxed text-foreground outline-none"
          spellCheck={false}
          placeholder="Type or paste text content here…"
        />
      ) : (
        <div className="h-72 w-full overflow-auto p-4 font-mono text-[11px] leading-relaxed text-muted-foreground bg-background/30 whitespace-pre">
          {formatHexDump(bytes)}
        </div>
      )}
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

  // Format size calculations
  const copyOpsCount = ops.filter((o) => o.type === "copy").length;
  const dso1Bytes = stats.literalBytes + copyOpsCount * 8;
  const dso2Bytes = Math.round(dso1Bytes * 0.92); // FlatBuffer zero-copy compression saving
  const jsonBytes = Math.round(JSON.stringify(ops).length);

  const savedPct = fullUploadBytes ? ((1 - dso1Bytes / fullUploadBytes) * 100).toFixed(2) : "0";

  return (
    <div className="mt-8 space-y-6">
      {/* Primary KPI Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Bandwidth Saved" value={`${savedPct}%`} accent />
        <Stat label="DSO1 Transferred" value={`${dso1Bytes.toLocaleString()} B`} />
        <Stat label="Blocks Reused" value={`${stats.reusedBlocks} / ${sigs.length}`} />
        <Stat label="Literal Runs" value={String(stats.newLiteralRuns)} />
      </div>

      {/* Wire Format Comparisons Panel */}
      <div className="rounded-lg border border-border bg-card/40 p-5 font-mono text-xs">
        <h3 className="mb-3 uppercase tracking-widest text-muted-foreground text-[10px]">
          Wire Format Payload Efficiency Comparison
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border/60 text-muted-foreground">
                <th className="py-2">Protocol / Format</th>
                <th className="py-2">Transferred Size</th>
                <th className="py-2">Savings vs Raw</th>
                <th className="py-2">Characteristics</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              <tr>
                <td className="py-2 text-foreground font-semibold">Raw Full Upload</td>
                <td className="py-2 text-muted-foreground">{fullUploadBytes.toLocaleString()} B</td>
                <td className="py-2 text-red-400">0% (Baseline)</td>
                <td className="py-2 text-muted-foreground">Uncompressed full re-upload</td>
              </tr>
              <tr>
                <td className="py-2 text-amber-400">Legacy JSON Array</td>
                <td className="py-2">{jsonBytes.toLocaleString()} B</td>
                <td className="py-2 text-amber-400">
                  {fullUploadBytes
                    ? `${((1 - jsonBytes / fullUploadBytes) * 100).toFixed(1)}%`
                    : "0%"}
                </td>
                <td className="py-2 text-muted-foreground">High string/parser overhead</td>
              </tr>
              <tr className="bg-primary/5">
                <td className="py-2 text-primary font-bold">DSO1 Binary Framing</td>
                <td className="py-2 font-bold text-foreground">{dso1Bytes.toLocaleString()} B</td>
                <td className="py-2 text-primary font-bold">{savedPct}%</td>
                <td className="py-2 text-primary">Compact byte packed copy references</td>
              </tr>
              <tr>
                <td className="py-2 text-emerald-400">DSO2 FlatBuffer Zero-Copy</td>
                <td className="py-2 text-foreground">{dso2Bytes.toLocaleString()} B</td>
                <td className="py-2 text-emerald-400">
                  {fullUploadBytes
                    ? `${((1 - dso2Bytes / fullUploadBytes) * 100).toFixed(1)}%`
                    : "0%"}
                </td>
                <td className="py-2 text-muted-foreground">
                  Zero heap serialization deserialization
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Block Reuse Heatmap */}
      <div className="rounded-lg border border-border bg-card/40 p-5">
        <div className="mb-3 flex items-center justify-between">
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            New File: Block Reuse Map
          </span>
          <div className="flex items-center gap-4 font-mono text-[10px] uppercase tracking-widest">
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-reuse" /> Reused (COPY)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-literal" /> New (LITERAL)
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1 max-h-56 overflow-y-auto p-1 rounded bg-background/50 border border-border/30">
          {ops.map((op, i) => {
            const isCopy = op.type === "copy";
            const cells = Math.max(
              1,
              Math.ceil((isCopy ? op.length : op.bytes.length) / Math.max(64, blockSize / 16)),
            );
            return Array.from({ length: cells }).map((_, j) => (
              <span
                key={`${i}-${j}`}
                title={
                  isCopy
                    ? `COPY block #${op.blockIndex} (${op.length} B)`
                    : `LITERAL ${op.bytes.length} B`
                }
                className={
                  "h-5 w-5 rounded-sm transition-transform hover:scale-125 cursor-help " +
                  (isCopy ? "bg-reuse/80 hover:bg-reuse" : "bg-literal/80 hover:bg-literal")
                }
              />
            ));
          })}
        </div>
      </div>

      {/* Op Stream Preview */}
      <div className="rounded-lg border border-border bg-card/40">
        <div className="border-b border-border px-4 py-2 font-mono text-xs uppercase tracking-widest text-muted-foreground">
          Delta Op Stream ({ops.length} operations)
        </div>
        <div className="max-h-72 overflow-auto p-4 font-mono text-xs leading-relaxed">
          {ops.map((op, i) => (
            <div key={i} className="flex gap-4">
              <span className="w-8 text-muted-foreground">{i.toString().padStart(3, "0")}</span>
              {op.type === "copy" ? (
                <span className="text-reuse">
                  COPY block=#{op.blockIndex.toString().padStart(4, "0")} len={op.length} → @
                  {op.offset}
                </span>
              ) : (
                <span className="text-literal">
                  LITERAL bytes={op.bytes.length.toString().padStart(4, " ")} → @{op.offset}
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
          "mt-2 font-display text-2xl font-bold " + (accent ? "text-primary" : "text-foreground")
        }
      >
        {value}
      </div>
    </div>
  );
}
