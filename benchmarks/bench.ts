#!/usr/bin/env npx tsx
/**
 * Delta Sync Engine — Benchmark Suite
 *
 * Compares three sync strategies across different workloads:
 *   a) Full re-upload (simulates `aws s3 sync` / naive copy)
 *   b) rsync fixed-block delta (4 KiB blocks, Adler-32 + SHA-256)
 *   c) Deltasync CDC delta (FastCDC content-defined chunks, ~16 KiB avg)
 *
 * Workloads:
 *   1. Large single file   — 100 MB base, 1% appended
 *   2. Many small files    — 1,000 × 10 KB, 5% changed
 *   3. Mixed               — 50 MB file + 500 × 10 KB small files
 *
 * NOTE: File sizes are scaled down from the spec (1GB→100MB, 10K→1K files)
 *       for practical runtime on commodity hardware. The ratios and
 *       percentages remain identical, so the efficiency comparisons are valid.
 *
 * Usage:  npx tsx benchmarks/bench.ts
 */

import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSignatures, computeDelta, contentHash } from "../cli/src/rsync.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(2)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(2)} KB`;
  return `${b} B`;
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(0)}ms`;
}

function pct(part: number, whole: number): string {
  if (whole === 0) return "0.0%";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

interface BenchResult {
  strategy: string;
  workload: string;
  originalSize: number;
  modifiedSize: number;
  transferBytes: number;
  timeMs: number;
  peakMemMB: number;
  timeSavedPct: string;
  bwSavedPct: string;
}

const results: BenchResult[] = [];

// ─── Strategy: Full Re-upload ─────────────────────────────────────────────────

async function benchFullUpload(
  workload: string,
  _originalData: Buffer,
  modifiedData: Buffer,
): Promise<BenchResult> {
  const memBefore = process.memoryUsage().heapUsed;
  const start = performance.now();

  // Full re-upload: the entire modified file is the transfer payload
  const transferBytes = modifiedData.length;
  // Simulate computing a content hash (the only work a naive uploader does)
  await contentHash(modifiedData);

  const elapsed = performance.now() - start;
  const memAfter = process.memoryUsage().heapUsed;
  const peakMemMB = Math.max(0, (memAfter - memBefore) / 1e6);

  return {
    strategy: "Full Re-upload (aws s3 sync)",
    workload,
    originalSize: _originalData.length,
    modifiedSize: modifiedData.length,
    transferBytes,
    timeMs: elapsed,
    peakMemMB,
    timeSavedPct: "0.0%",  // baseline
    bwSavedPct: "0.0%",    // baseline
  };
}

// ─── Strategy: rsync Fixed-Block Delta ────────────────────────────────────────

async function benchFixedDelta(
  workload: string,
  originalData: Buffer,
  modifiedData: Buffer,
): Promise<BenchResult> {
  const memBefore = process.memoryUsage().heapUsed;
  const start = performance.now();

  // 1. Build signatures from the "remote" original
  const sigs = await buildSignatures(originalData, { chunking: "fixed", blockSize: 4096 });

  // 2. Compute delta
  const delta = await computeDelta(modifiedData, sigs, { chunking: "fixed", blockSize: 4096 });

  const elapsed = performance.now() - start;
  const memAfter = process.memoryUsage().heapUsed;
  const peakMemMB = Math.max(0, (memAfter - memBefore) / 1e6);

  return {
    strategy: "rsync Fixed-Block (4 KiB)",
    workload,
    originalSize: originalData.length,
    modifiedSize: modifiedData.length,
    transferBytes: delta.literalBytes.length,
    timeMs: elapsed,
    peakMemMB,
    timeSavedPct: "",
    bwSavedPct: "",
  };
}

// ─── Strategy: Deltasync CDC Delta ────────────────────────────────────────────

async function benchCdcDelta(
  workload: string,
  originalData: Buffer,
  modifiedData: Buffer,
): Promise<BenchResult> {
  const memBefore = process.memoryUsage().heapUsed;
  const start = performance.now();

  // 1. Build CDC signatures from the "remote" original
  const sigs = await buildSignatures(originalData, { chunking: "cdc", blockSize: 16384 });

  // 2. Compute CDC delta
  const delta = await computeDelta(modifiedData, sigs, { chunking: "cdc", blockSize: 16384 });

  const elapsed = performance.now() - start;
  const memAfter = process.memoryUsage().heapUsed;
  const peakMemMB = Math.max(0, (memAfter - memBefore) / 1e6);

  return {
    strategy: "Deltasync CDC (16 KiB avg)",
    workload,
    originalSize: originalData.length,
    modifiedSize: modifiedData.length,
    transferBytes: delta.literalBytes.length,
    timeMs: elapsed,
    peakMemMB,
    timeSavedPct: "",
    bwSavedPct: "",
  };
}

// ─── Run a Workload ───────────────────────────────────────────────────────────

async function runWorkload(
  name: string,
  originalData: Buffer,
  modifiedData: Buffer,
) {
  console.log(`\n━━━ Workload: ${name} ━━━`);
  console.log(`  Original: ${fmtBytes(originalData.length)}  →  Modified: ${fmtBytes(modifiedData.length)}`);

  const full = await benchFullUpload(name, originalData, modifiedData);
  const fixed = await benchFixedDelta(name, originalData, modifiedData);
  const cdc = await benchCdcDelta(name, originalData, modifiedData);

  // Compute relative savings vs full upload baseline
  fixed.timeSavedPct = pct(full.timeMs - fixed.timeMs, full.timeMs);
  fixed.bwSavedPct = pct(full.transferBytes - fixed.transferBytes, full.transferBytes);
  cdc.timeSavedPct = pct(full.timeMs - cdc.timeMs, full.timeMs);
  cdc.bwSavedPct = pct(full.transferBytes - cdc.transferBytes, full.transferBytes);

  for (const r of [full, fixed, cdc]) {
    console.log(`  [${r.strategy}]`);
    console.log(`    Transfer: ${fmtBytes(r.transferBytes)}  |  Time: ${fmtMs(r.timeMs)}  |  Mem: ${r.peakMemMB.toFixed(1)} MB`);
    console.log(`    BW saved: ${r.bwSavedPct}  |  Time saved: ${r.timeSavedPct}`);
    results.push(r);
  }
}

// ─── Workload Generators ──────────────────────────────────────────────────────

function generateLargeSingleFile(): { original: Buffer; modified: Buffer } {
  // 100 MB base, append 1 MB (1% change)
  const SIZE = 100 * 1024 * 1024;
  const APPEND = Math.round(SIZE * 0.01);
  const original = randomBytes(SIZE);
  const modified = Buffer.concat([original, randomBytes(APPEND)]);
  return { original, modified };
}

function generateManySmallFiles(): { original: Buffer; modified: Buffer } {
  // 1,000 × 10 KB files concatenated. 5% of files are completely replaced.
  const FILE_COUNT = 1000;
  const FILE_SIZE = 10 * 1024;
  const CHANGE_RATE = 0.05;

  const origParts: Buffer[] = [];
  const modParts: Buffer[] = [];

  for (let i = 0; i < FILE_COUNT; i++) {
    const chunk = randomBytes(FILE_SIZE);
    origParts.push(chunk);
    if (Math.random() < CHANGE_RATE) {
      modParts.push(randomBytes(FILE_SIZE)); // completely new content
    } else {
      modParts.push(chunk);
    }
  }

  return {
    original: Buffer.concat(origParts),
    modified: Buffer.concat(modParts),
  };
}

function generateMixed(): { original: Buffer; modified: Buffer } {
  // 50 MB large file (append 0.5 MB) + 500 × 10 KB small files (5% changed)
  const LARGE = 50 * 1024 * 1024;
  const APPEND = Math.round(LARGE * 0.01);
  const SMALL_COUNT = 500;
  const SMALL_SIZE = 10 * 1024;

  const largePart = randomBytes(LARGE);
  const largeModified = Buffer.concat([largePart, randomBytes(APPEND)]);

  const smallOrigParts: Buffer[] = [];
  const smallModParts: Buffer[] = [];
  for (let i = 0; i < SMALL_COUNT; i++) {
    const chunk = randomBytes(SMALL_SIZE);
    smallOrigParts.push(chunk);
    if (Math.random() < 0.05) {
      smallModParts.push(randomBytes(SMALL_SIZE));
    } else {
      smallModParts.push(chunk);
    }
  }

  return {
    original: Buffer.concat([largePart, ...smallOrigParts]),
    modified: Buffer.concat([largeModified, ...smallModParts]),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║     Delta Sync Engine — Benchmark Suite                 ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log();
  console.log("Strategies:");
  console.log("  a) Full Re-upload   — entire file transferred (aws s3 sync baseline)");
  console.log("  b) rsync Fixed      — 4 KiB fixed blocks, Adler-32 + SHA-256");
  console.log("  c) Deltasync CDC    — FastCDC content-defined chunks (~16 KiB avg)");

  // Workload 1: Large single file
  console.log("\n\nGenerating workload 1: Large single file (100 MB, 1% append)...");
  const w1 = generateLargeSingleFile();
  await runWorkload("Large Single File (100 MB, 1% change)", w1.original, w1.modified);
  // Free memory
  (w1 as any).original = null;
  (w1 as any).modified = null;
  global.gc?.();

  // Workload 2: Many small files
  console.log("\n\nGenerating workload 2: Many small files (1,000 × 10 KB, 5% changed)...");
  const w2 = generateManySmallFiles();
  await runWorkload("Many Small Files (1K × 10 KB, 5% changed)", w2.original, w2.modified);
  (w2 as any).original = null;
  (w2 as any).modified = null;
  global.gc?.();

  // Workload 3: Mixed
  console.log("\n\nGenerating workload 3: Mixed (50 MB + 500 small files)...");
  const w3 = generateMixed();
  await runWorkload("Mixed (50 MB + 500 × 10 KB)", w3.original, w3.modified);

  // ─── Output Results ─────────────────────────────────────────────────────────

  console.log("\n\n");
  console.log("═══════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log("  RESULTS SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════════════════════════════════════════════════════");

  const header = [
    "Workload".padEnd(42),
    "Strategy".padEnd(30),
    "Transfer".padEnd(14),
    "Time".padEnd(10),
    "BW Saved".padEnd(12),
    "Time Saved".padEnd(12),
    "Mem (MB)".padEnd(10),
  ].join("│ ");
  console.log(header);
  console.log("─".repeat(140));

  for (const r of results) {
    const row = [
      r.workload.padEnd(42),
      r.strategy.padEnd(30),
      fmtBytes(r.transferBytes).padEnd(14),
      fmtMs(r.timeMs).padEnd(10),
      r.bwSavedPct.padEnd(12),
      r.timeSavedPct.padEnd(12),
      r.peakMemMB.toFixed(1).padEnd(10),
    ].join("│ ");
    console.log(row);
  }

  // Write raw JSON results
  const outDir = join(import.meta.dirname!, "..");
  const outPath = join(outDir, "benchmarks", "results.json");
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n\nRaw results saved to: ${outPath}`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
