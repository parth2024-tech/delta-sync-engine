# High-Performance Delta-Based File Synchronization Engine

A client-server system that syncs large files by transferring only changed byte ranges, using the rsync rolling-hash algorithm. Designed as a real working CLI/daemon + a web dashboard for monitoring sync jobs.

## Architecture Overview

```text
 ┌────────────────┐         delta protocol          ┌────────────────┐
 │  Client (CLI)  │  ──────── HTTPS / WS ────────►  │  Sync Server   │
 │  + SQLite      │                                 │  + Object Store│
 │  + Rolling Hash│  ◄──── block signatures ─────   │  + Postgres    │
 └────────────────┘                                 └────────────────┘
         │                                                    │
         └─────────── Web Dashboard (this app) ───────────────┘
                  monitors jobs, files, versions, bandwidth
```

The Lovable app serves three roles:
1. **Sync Server** — TanStack Start server routes implementing the rsync delta protocol over HTTP.
2. **Web Dashboard** — React UI to browse synced files, version history, and bandwidth savings.
3. **Reference Client** — a downloadable Node.js CLI (in `/cli`) demonstrating rolling hash + SQLite cache.

## Step-by-Step Plan

### Step 1 — Foundation & Design System
- Enable Lovable Cloud (Postgres for server-side metadata, Storage for file blobs, Auth for API tokens).
- Build dark technical design system (terminal/monitoring aesthetic): JetBrains Mono + Inter, deep slate background, electric cyan accents, subtle grid textures.
- Create base layout with sidebar nav: Dashboard, Files, Sync Jobs, API Keys, Docs.

### Step 2 — Database Schema (Server-Side Postgres)
Tables (with RLS scoped to `auth.uid()`):
- `files` — id, user_id, path, size, current_version, mtime, content_hash
- `file_versions` — id, file_id, version_no, size, total_blocks, created_at
- `blocks` — id, version_id, offset, length, weak_hash (Adler-32), strong_hash (SHA-256), storage_key
- `sync_jobs` — id, user_id, file_id, started_at, finished_at, bytes_transferred, bytes_saved, status
- `api_keys` — id, user_id, key_hash, label, created_at, last_used_at

### Step 3 — Rolling Hash Core (Shared Library)
`src/lib/rsync/` (isomorphic, used by both server and CLI):
- `adler32.ts` — Adler-32 weak rolling hash with O(1) `roll(out, in)` update.
- `strong-hash.ts` — SHA-256 via Web Crypto.
- `signatures.ts` — given a file → emit list of `{offset, weak, strong}` per fixed block size (default 4 KiB, tunable).
- `delta.ts` — given old signatures + new file bytes → emit delta ops `{type: 'copy', blockId}` or `{type: 'literal', bytes}` using the classic rsync two-level lookup (16-bit hash table → strong hash verify).
- `patch.ts` — apply delta ops + old file → reconstructed new file.
- Unit tests for each (vitest).

### Step 4 — Sync Protocol (Server Routes)
Under `src/routes/api/public/sync/` (API-key authenticated, signature-verified):
- `POST /api/public/sync/signatures/:fileId` — server returns block signatures for the latest version (client uses these to compute delta locally).
- `POST /api/public/sync/upload/:fileId` — client streams delta ops; server reconstructs new version, stores new/changed blocks in Lovable Storage, writes new `file_versions` + `blocks` rows, returns bytes-saved stats.
- `GET /api/public/sync/download/:fileId?version=N` — server streams reconstructed file by reading block storage keys.
All endpoints require `Authorization: Bearer <api_key>`; key is hashed with SHA-256 and looked up in `api_keys`.

### Step 5 — Authenticated Server Functions (Dashboard Data)
`src/lib/sync.functions.ts` with `requireSupabaseAuth`:
- `listFiles` — paginated files for current user with latest-version stats.
- `getFileDetail` — file + all versions + per-version bandwidth metrics.
- `listSyncJobs` — recent jobs with bytes_transferred vs bytes_saved.
- `getDashboardStats` — totals: files, versions, bytes saved, transfer ratio, last 30 days chart.
- `createApiKey` / `revokeApiKey` — manage client tokens.

### Step 6 — Dashboard UI Pages
- `/` — landing: pitch, animated diagram of rolling-hash window, "how it works" section, CTA to sign up.
- `/login` — auth (email + password via Lovable Cloud).
- `/_authenticated/dashboard` — KPI cards (total saved bandwidth, dedup ratio, active syncs), 30-day area chart of bytes-transferred-vs-bytes-would-have-been, recent jobs table.
- `/_authenticated/files` — searchable table of synced files; row → detail.
- `/_authenticated/files/$fileId` — version timeline, per-version block reuse heatmap (visual: green = reused block, amber = new block), download buttons per version.
- `/_authenticated/jobs` — sync job log with filters and per-job delta breakdown.
- `/_authenticated/keys` — API key management (create/copy-once/revoke).
- `/_authenticated/docs` — protocol docs + CLI install/usage.

### Step 7 — In-Browser Sync Demo
Interactive `/_authenticated/playground`:
- Drag-drop two file versions (v1, v2) of the same file in browser.
- Run rolling-hash + delta computation client-side using the shared library.
- Visualize: block grid colored by reuse, animated rolling window, computed bytes-saved %, delta op list. Sells the algorithm without needing the CLI.

### Step 8 — Reference Client CLI
`/cli/` directory (Node.js, separate from web app, shipped as source the user can download/zip):
- `lovasync init` — creates local SQLite (`.lovasync/cache.db`) with tables `files`, `versions`, `blocks_cache`.
- `lovasync push <file>` — computes signatures locally, queries server for old signatures, builds delta, uploads.
- `lovasync pull <file>` — downloads delta from server, patches local copy.
- `lovasync status` — shows local vs remote version diff.
- README with install + auth instructions.

### Step 9 — Telemetry & Bandwidth Accounting
- Every sync job records `bytes_transferred` (delta size) and `bytes_saved` (full file size − delta size).
- Dashboard aggregates these into the headline metric: "X GB saved across Y syncs (Z% efficiency)".

### Step 10 — Polish & SEO
- Add `sitemap.xml` and `robots.txt`.
- Per-route `head()` metadata.
- Loading skeletons, error boundaries, 404.
- Run security scan; lock down RLS on all tables.

## Technical Details (for reference)

**Rolling hash math**: Adler-32 over window `[i, i+B)` → on slide, `A' = A − bytes[i] + bytes[i+B]`, `B' = B − B·bytes[i] + A'`. O(1) per byte vs O(B) recompute.

**Delta algorithm**: Build hash table `weak16 → [block_indices]` from old signatures. Slide window over new file; on weak match, verify with SHA-256; on hit, emit `copy(blockId)` and jump window forward by B; on miss, emit `literal(byte)` and slide by 1 (buffering literals into runs).

**Block size choice**: 4 KiB default. Smaller = better dedup, larger overhead. Configurable per-file via metadata.

**Why SQLite on the client**: avoids re-hashing unchanged files between runs (cache `mtime + content_hash`) and lets `pull` resume after partial transfer.

**Scope boundaries**: This Lovable app delivers the sync server + dashboard + in-browser demo + CLI source. Multi-machine real-time peer sync, encryption-at-rest, and conflict resolution are deliberately deferred to v2.
