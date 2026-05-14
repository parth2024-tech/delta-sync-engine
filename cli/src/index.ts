#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();
import { readFileSync, writeFileSync, statSync, existsSync } from "fs";
import { createInterface } from "readline";
import { readConfig, writeConfig } from "./config.js";
import { getFile, upsertFile } from "./db.js";
import { computeDelta, contentHash } from "./rsync.js";
import * as api from "./api.js";

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
  const blockSize = remote?.blockSize ?? (chunking === "cdc" ? 16384 : 4096);

  if (remote) {
    console.log(`  remote: v${remote.versionNo}, ${remote.signatures.length} chunks (${chunking})`);
  } else {
    console.log("  remote: new file (CDC avg 16 KiB)");
  }

  const { ops, literalBytes } = await computeDelta(
    data,
    remote?.signatures ?? [],
    { chunking, blockSize },
  );

  const literals = ops.filter((o) => o.type === "literal").length;
  const copies   = ops.filter((o) => o.type === "copy").length;
  console.log(`  delta: ${literals} literal run(s), ${copies} copy op(s)`);
  console.log(`  literal payload: ${fmtBytes(literalBytes.length)} raw (was base64 before)`);

  const result = await api.upload(
    cfg,
    { path: filePath, chunking, blockSize, newSize: data.length, contentSha256: hash, ops },
    literalBytes,
  );

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

function fmtBytes(b: number) {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(1)} KB`;
  return `${b} B`;
}

program.parse(process.argv);
