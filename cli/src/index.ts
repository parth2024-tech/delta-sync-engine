#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync, existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "readline";
import { Command } from "commander";

import { readConfig, writeConfig } from "./config.js";
import { getFile, upsertFile, listFiles as listCachedFiles, pruneCache } from "./db.js";
import { computeDelta, contentHash, encodeOpsBinaryV1, adaptiveChunkSize, SMALL_FILE_THRESHOLD } from "./rsync.js";
import type { Op } from "./rsync.js";
import { decodeOpsBinaryV1 } from "../../shared/ops-binary.js";
import * as api from "./api.js";
import type { UploadMetaJson } from "./api.js";
import { syncAll } from "./sync.js";

const program = new Command();

function resolveNativeBinary(): string | null {
  const fromEnv = process.env.DELTASYNC_NATIVE;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const here = dirname(fileURLToPath(import.meta.url));
  const release = join(here, "../../../../native/target/release/deltasync-native");
  if (existsSync(release)) return release;
  const debug = join(here, "../../../../native/target/debug/deltasync-native");
  if (existsSync(debug)) return debug;
  return null;
}

const OP_BIN_THRESHOLD = Math.max(1, parseInt(process.env.OP_BIN_THRESHOLD || "8192", 10) || 8192);

program.name("deltasync").description("Delta-based file sync CLI").version("0.1.0");

// ─── init ──────────────────────────────────────────────────────────────────────
program.command("init").description("Initialise Deltasync in the current directory").action(async () => {
  const rl  = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));

  console.log("Deltasync init\n");
  const serverUrl = (await ask("Server URL [http://localhost:5000]: ")).trim() || "http://localhost:5000";
  const apiKey    = (await ask("API key (dks_…): ")).trim();
  rl.close();

  if (!apiKey.startsWith("dks_")) { console.error("Key must start with dks_"); process.exit(1); }
  writeConfig({ serverUrl: serverUrl.replace(/\/$/, ""), apiKey });
  console.log("✓ Config saved to .deltasync/config.json");
});

// ─── push ──────────────────────────────────────────────────────────────────────
program.command("push <file>").description("Push a local file to the server").action(async (filePath: string) => {
  const cfg    = readConfig();
  if (!existsSync(filePath)) { console.error(`File not found: ${filePath}`); process.exit(1); }

  const stat   = statSync(filePath);
  const data   = readFileSync(filePath);
  const hash   = await contentHash(data);
  const cached = getFile(filePath);

  if (cached?.last_hash === hash) { console.log(`✓ ${filePath} — unchanged, skipping`); return; }

  console.log(`Fetching remote signatures for ${filePath}…`);
  const remote    = await api.getSignatures(cfg, filePath);
  const chunking  = remote?.chunking === "fixed" ? "fixed" : "cdc";

  // Adaptive chunk sizing: select optimal block size based on file size
  const adaptiveSize = adaptiveChunkSize(data.length);
  const blockSize = adaptiveSize > 0
    ? adaptiveSize
    : (remote?.blockSize ?? (chunking === "cdc" ? 16384 : 4096));

  // Small files below threshold: skip CDC entirely, upload as single literal if hash differs
  if (adaptiveSize === 0 && !remote) {
    console.log(`  small file (${fmtBytes(data.length)}) — full upload (CDC skipped)`);
    const meta: UploadMetaJson = {
      path: filePath, chunking: "cdc", blockSize: 4096,
      newSize: data.length, contentSha256: hash,
      opsEncoding: "json",
      ops: [{ type: "literal", literalOffset: 0, literalLength: data.length }],
    };
    const result = await api.upload(cfg, meta, data);
    upsertFile(filePath, stat.mtimeMs, stat.size, hash, result.versionNo);
    console.log(`✓ pushed v${result.versionNo} — small file upload`);
    return;
  }

  if (remote) {
    console.log(`  remote: v${remote.versionNo}, ${remote.signatures.length} chunks (${chunking}, blockSize=${blockSize})`);
  } else {
    console.log(`  remote: new file (CDC avg ${fmtBytes(blockSize)})`);
  }

  const nativeBin = resolveNativeBinary();
  const minNative = Math.max(0, parseInt(process.env.DELTASYNC_NATIVE_MIN_BYTES || "2097152", 10) || 2097152);
  const useNativePack = Boolean(nativeBin && chunking === "cdc" && data.length >= minNative);

  let ops: Op[];
  let literalBytes: Buffer;

  if (useNativePack && nativeBin) {
    console.log(`  using native pack-delta (${nativeBin})`);
    const dir = mkdtempSync(join(tmpdir(), "deltasync-"));
    try {
      const remotePath = join(dir, "remote.json");
      writeFileSync(remotePath, JSON.stringify(remote ?? { signatures: [], blockSize, chunking }));
      const outOps = join(dir, "ops.bin");
      const outLit = join(dir, "literals.bin");
      const r = spawnSync(
        nativeBin,
        [
          "pack-delta",
          "--local", filePath,
          "--remote-json", remotePath,
          "--out-ops", outOps,
          "--out-literals", outLit,
          "--block-size", String(blockSize),
          "--chunking", "cdc",
        ],
        { encoding: "utf8" },
      );
      if (r.error) throw r.error;
      if (r.status !== 0) {
        const errMsg = [r.stderr, r.stdout].map((x) => (x == null ? "" : String(x))).join("\n").trim();
        throw new Error(errMsg || "native pack-delta failed");
      }
      literalBytes = readFileSync(outLit);
      const opsBin = readFileSync(outOps);
      const decoded = decodeOpsBinaryV1(opsBin);
      const meta: UploadMetaJson = {
        path:          filePath,
        chunking,
        blockSize,
        newSize:       data.length,
        contentSha256: hash,
        opsEncoding:   "bin",
        opCount:       decoded.length,
      };
      const literals = decoded.filter((o: Op) => o.type === "literal").length;
      const copies   = decoded.filter((o: Op) => o.type === "copy").length;
      console.log(`  delta: ${literals} literal run(s), ${copies} copy op(s) [native]`);
      console.log(`  literal payload: ${fmtBytes(literalBytes.length)} raw`);
      console.log(`  ops wire: binary (${opsBin.length} B)`);

      const result = await api.upload(cfg, meta, literalBytes, opsBin);
      upsertFile(filePath, stat.mtimeMs, stat.size, hash, result.versionNo);
      const savedPct = data.length > 0 ? Math.round((result.bytesSaved / data.length) * 100) : 0;
      console.log(`✓ pushed v${result.versionNo} — saved ${fmtBytes(result.bytesSaved)} (${savedPct}%)`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return;
  }

  const delta = await computeDelta(
    data,
    remote?.signatures ?? [],
    { chunking, blockSize },
  );
  ops = delta.ops;
  literalBytes = delta.literalBytes;

  const literals = ops.filter((o) => o.type === "literal").length;
  const copies   = ops.filter((o) => o.type === "copy").length;
  console.log(`  delta: ${literals} literal run(s), ${copies} copy op(s)`);
  console.log(`  literal payload: ${fmtBytes(literalBytes.length)} raw`);

  const useBin = ops.length >= OP_BIN_THRESHOLD || process.env.FORCE_OPS_BIN === "1";
  let result: { versionNo: number; bytesSaved: number };
  if (useBin) {
    const opsBin = encodeOpsBinaryV1(ops);
    console.log(`  ops wire: binary (${opsBin.length} B, threshold ${OP_BIN_THRESHOLD})`);
    const meta: UploadMetaJson = {
      path:          filePath,
      chunking,
      blockSize,
      newSize:       data.length,
      contentSha256: hash,
      opsEncoding:   "bin",
      opCount:       ops.length,
    };
    result = await api.upload(cfg, meta, literalBytes, opsBin);
  } else {
    console.log(`  ops wire: JSON (${ops.length} op(s))`);
    const meta: UploadMetaJson = {
      path:          filePath,
      chunking,
      blockSize,
      newSize:       data.length,
      contentSha256: hash,
      opsEncoding:   "json",
      ops,
    };
    result = await api.upload(cfg, meta, literalBytes);
  }

  upsertFile(filePath, stat.mtimeMs, stat.size, hash, result.versionNo);
  const savedPct = data.length > 0 ? Math.round((result.bytesSaved / data.length) * 100) : 0;
  console.log(`✓ pushed v${result.versionNo} — saved ${fmtBytes(result.bytesSaved)} (${savedPct}%)`);
});

// ─── pull ──────────────────────────────────────────────────────────────────────
program.command("pull <file>")
  .option("--version <n>", "specific version number")
  .description("Pull a file from the server")
  .action(async (filePath: string, opts: { version?: string }) => {
    const cfg = readConfig();
    const ver = opts.version ? parseInt(opts.version) : undefined;
    console.log(`Pulling ${filePath}${ver != null ? ` v${ver}` : ""}…`);
    const buf = await api.download(cfg, filePath, ver);
    writeFileSync(filePath, buf);
    const hash = await contentHash(buf);
    upsertFile(filePath, Date.now(), buf.length, hash, ver ?? 0);
    console.log(`✓ ${filePath} (${fmtBytes(buf.length)})`);
  });

// ─── status ────────────────────────────────────────────────────────────────────
program.command("status").description("Compare local files to server").action(async () => {
  const cfg        = readConfig();
  const remoteList = await api.listFiles(cfg);
  if (!remoteList.length) { console.log("No files on server."); return; }
  console.log(`\n${"PATH".padEnd(40)} ${"LOCAL VER".padEnd(12)} ${"SERVER SIZE"}`);
  console.log("─".repeat(70));
  for (const rf of remoteList) {
    const local    = getFile(rf.path);
    const localVer = local ? `v${local.server_version}` : "(not pulled)";
    console.log(`${rf.path.padEnd(40)} ${localVer.padEnd(12)} ${fmtBytes(rf.totalSize)}`);
  }
  console.log();
});

// ─── sync ──────────────────────────────────────────────────────────────────────
program.command("sync")
  .argument("[files...]", "files to sync (defaults to all tracked files)")
  .option("--force-push", "resolve conflicts by pushing local version")
  .option("--force-pull", "resolve conflicts by pulling server version")
  .description("Two-way sync: push local changes, pull server changes, detect conflicts")
  .action(async (files: string[], opts: { forcePush?: boolean; forcePull?: boolean }) => {
    const paths = files.length > 0 ? files : listCachedFiles();
    if (paths.length === 0) {
      console.log("No files to sync. Push or pull a file first, or specify file paths.");
      return;
    }
    console.log(`\nSyncing ${paths.length} file(s)…\n`);
    const result = await syncAll(paths, opts);
    console.log(`\n── Sync Summary ──`);
    if (result.pushed.length)    console.log(`  ↑ Pushed:    ${result.pushed.length}`);
    if (result.pulled.length)    console.log(`  ↓ Pulled:    ${result.pulled.length}`);
    if (result.conflicts.length) console.log(`  ⚠ Conflicts: ${result.conflicts.length}`);
    if (result.skipped.length)   console.log(`  ─ Skipped:   ${result.skipped.length}`);
    console.log();
  });

// ─── gc ────────────────────────────────────────────────────────────────────────
program.command("gc")
  .option("--max-entries <n>", "maximum cache entries to keep", "1000")
  .description("Clean up local cache: remove stale entries and enforce size limit")
  .action((opts: { maxEntries: string }) => {
    const max = parseInt(opts.maxEntries) || 1000;
    const removed = pruneCache(max);
    const remaining = listCachedFiles().length;
    console.log(`\nCache GC complete:`);
    console.log(`  Removed: ${removed} stale/excess entries`);
    console.log(`  Remaining: ${remaining} entries`);
    console.log(`  Max allowed: ${max}`);
    console.log();
  });

function fmtBytes(b: number) {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(1)} KB`;
  return `${b} B`;
}

program.parse(process.argv);
