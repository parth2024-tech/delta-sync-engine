#!/usr/bin/env node
import { program } from "commander";
import { readFileSync, writeFileSync, statSync, existsSync } from "fs";
import { createInterface } from "readline";
import { readConfig, writeConfig, configExists } from "./config.js";
import { getFile, upsertFile } from "./db.js";
import { buildSignatures, computeDelta, contentHash } from "./rsync.js";
import * as api from "./api.js";

program.name("deltasync").description("Delta-based file sync CLI").version("0.1.0");

// ─── init ──────────────────────────────────────────────────────────────────────
program.command("init").description("Initialise Deltasync in the current directory").action(async () => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
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
  const cfg = readConfig();
  if (!existsSync(filePath)) { console.error(`File not found: ${filePath}`); process.exit(1); }

  const stat    = statSync(filePath);
  const data    = readFileSync(filePath);
  const hash    = await contentHash(data);
  const cached  = getFile(filePath);

  if (cached?.last_hash === hash) { console.log(`✓ ${filePath} — unchanged, skipping`); return; }

  console.log(`Fetching remote signatures for ${filePath}…`);
  const remote = await api.getSignatures(cfg, filePath);

  let ops;
  const blockSize = remote?.blockSize ?? 4096;
  if (remote) {
    console.log(`  remote: v${remote.versionNo}, ${remote.signatures.length} blocks`);
    ops = await computeDelta(data, remote.signatures, blockSize);
  } else {
    console.log("  remote: new file");
    ops = await computeDelta(data, [], blockSize);
  }

  const literals   = ops.filter((o) => o.type === "literal").length;
  const copies     = ops.filter((o) => o.type === "copy").length;
  console.log(`  delta: ${literals} literal, ${copies} copy ops`);

  const result = await api.upload(cfg, {
    path: filePath, blockSize, newSize: data.length, contentSha256: hash, ops,
  });

  upsertFile(filePath, stat.mtimeMs, stat.size, hash, (remote?.versionNo ?? 0) + 1);
  const savedPct = data.length > 0 ? Math.round((result.bytesSaved / data.length) * 100) : 0;
  console.log(`✓ pushed — saved ${fmtBytes(result.bytesSaved)} (${savedPct}%)`);
});

// ─── pull ──────────────────────────────────────────────────────────────────────
program.command("pull <file>").option("--version <n>", "specific version number").description("Pull a file from the server").action(async (filePath: string, opts: { version?: string }) => {
  const cfg  = readConfig();
  const ver  = opts.version ? parseInt(opts.version) : undefined;
  console.log(`Pulling ${filePath}${ver != null ? ` v${ver}` : ""}…`);
  const data = await api.download(cfg, filePath, ver);
  writeFileSync(filePath, data);
  const hash = await contentHash(data);
  upsertFile(filePath, Date.now(), data.length, hash, ver ?? 0);
  console.log(`✓ ${filePath} (${fmtBytes(data.length)})`);
});

// ─── status ────────────────────────────────────────────────────────────────────
program.command("status").description("Compare local files to server").action(async () => {
  const cfg        = readConfig();
  const remoteList = await api.listFiles(cfg);
  if (!remoteList.length) { console.log("No files on server."); return; }
  console.log(`\n${"PATH".padEnd(40)} ${"LOCAL VER".padEnd(12)} ${"SERVER SIZE"}`);
  console.log("─".repeat(70));
  for (const rf of remoteList) {
    const local = getFile(rf.path);
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

program.parse();
