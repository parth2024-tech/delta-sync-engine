/**
 * Two-way sync logic with conflict detection.
 *
 * For each tracked file:
 *   - Local-only changes → push
 *   - Server-only changes → pull
 *   - Both changed → conflict (user must resolve)
 *
 * Uses the cached `last_hash` as the common ancestor for three-way detection.
 */

import { readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { readConfig } from "./config.js";
import { getFile, upsertFile, listFiles as listCachedFiles } from "./db.js";
import { contentHash } from "./rsync.js";
import * as api from "./api.js";

export interface SyncResult {
  pushed: string[];
  pulled: string[];
  conflicts: string[];
  skipped: string[];
}

export async function syncAll(paths: string[], opts: { forcePush?: boolean; forcePull?: boolean } = {}): Promise<SyncResult> {
  const cfg = readConfig();
  const result: SyncResult = { pushed: [], pulled: [], conflicts: [], skipped: [] };

  for (const filePath of paths) {
    const syncResult = await syncFile(cfg, filePath, opts);
    result[syncResult].push(filePath);
  }

  return result;
}

type SyncAction = "pushed" | "pulled" | "conflicts" | "skipped";

async function syncFile(
  cfg: ReturnType<typeof readConfig>,
  filePath: string,
  opts: { forcePush?: boolean; forcePull?: boolean },
): Promise<SyncAction> {
  const cached = getFile(filePath);
  const localExists = existsSync(filePath);

  // Fetch server-side metadata (lightweight, no binary download)
  let serverInfo: api.FileInfo | null = null;
  try {
    serverInfo = await api.getFileInfo(cfg, filePath);
  } catch {
    // Server unreachable or file not found
  }

  // Compute local hash if file exists
  let localHash: string | null = null;
  if (localExists) {
    const data = readFileSync(filePath);
    localHash = await contentHash(data);
  }

  const ancestorHash = cached?.last_hash ?? null;
  const serverHash = serverInfo?.contentSha256 ?? null;

  const localChanged = localHash !== null && localHash !== ancestorHash;
  const serverChanged = serverHash !== null && serverHash !== ancestorHash;

  // Case 1: Both unchanged
  if (!localChanged && !serverChanged) {
    return "skipped";
  }

  // Case 2: Local and server have the same hash (convergent)
  if (localHash && serverHash && localHash === serverHash) {
    // Update cache to reflect current state
    if (localExists && serverInfo) {
      const stat = statSync(filePath);
      upsertFile(filePath, stat.mtimeMs, stat.size, localHash, serverInfo.versionNo);
    }
    return "skipped";
  }

  // Case 3: Only local changed → push
  if (localChanged && !serverChanged) {
    console.log(`  ↑ ${filePath} — local changes, pushing…`);
    // Delegate to the existing push command logic
    return "pushed";
  }

  // Case 4: Only server changed → pull
  if (!localChanged && serverChanged) {
    console.log(`  ↓ ${filePath} — server changes, pulling…`);
    try {
      const buf = await api.download(cfg, filePath);
      writeFileSync(filePath, buf);
      const hash = await contentHash(buf);
      upsertFile(filePath, Date.now(), buf.length, hash, serverInfo!.versionNo);
      return "pulled";
    } catch (err) {
      console.error(`  ✗ Failed to pull ${filePath}:`, err);
      return "conflicts";
    }
  }

  // Case 5: Both changed → conflict
  if (localChanged && serverChanged) {
    if (opts.forcePush) {
      console.log(`  ⚠ ${filePath} — conflict resolved: force-push`);
      return "pushed";
    }
    if (opts.forcePull) {
      console.log(`  ⚠ ${filePath} — conflict resolved: force-pull`);
      try {
        const buf = await api.download(cfg, filePath);
        writeFileSync(filePath, buf);
        const hash = await contentHash(buf);
        upsertFile(filePath, Date.now(), buf.length, hash, serverInfo!.versionNo);
        return "pulled";
      } catch (err) {
        console.error(`  ✗ Failed to force-pull ${filePath}:`, err);
        return "conflicts";
      }
    }

    console.log(`  ⚠ ${filePath} — CONFLICT (both local and server changed)`);
    console.log(`    local:  ${localHash?.slice(0, 12)}…`);
    console.log(`    server: ${serverHash?.slice(0, 12)}…`);
    console.log(`    base:   ${ancestorHash?.slice(0, 12) ?? "(none)"}…`);
    console.log(`    Resolve with: deltasync sync --force-push or --force-pull`);
    return "conflicts";
  }

  return "skipped";
}
