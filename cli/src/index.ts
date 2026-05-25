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
import { performPush } from "./push.js";

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
  try {
    const cfg = readConfig();
    await performPush(filePath, cfg);
  } catch (err) {
    console.error(`✗ Push failed: ${(err as Error).message}`);
    process.exit(1);
  }
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
