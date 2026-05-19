# Comparison: Deltasync vs rsync vs aws s3 sync

An honest technical comparison based on real benchmark data.

---

## Why not just use `rsync`?

### Short answer: You should, sometimes.

rsync is a battle-tested, 30-year-old tool. It's excellent at what it does. Deltasync doesn't replace rsync — it fills a gap that rsync can't reach: **efficient delta sync directly to S3-compatible object storage without an SSH-accessible server.**

### The real comparison

| Dimension | `rsync` (over SSH) | `aws s3 sync` | **Deltasync** |
|:---|:---|:---|:---|
| **Bandwidth efficiency** | ★★★★★ (99%+ savings with fixed blocks) | ★☆☆☆☆ (full re-upload every time) | ★★★★☆ (90–99% savings with CDC) |
| **Compute speed** | ★★☆☆☆ (byte-by-byte rolling window) | ★★★★★ (just uploads, no delta compute) | ★★★★☆ (single-pass CDC, 20× faster than rsync) |
| **Memory usage** | ★★☆☆☆ (10–20 MB per 100 MB file) | ★★★★★ (streaming, minimal) | ★★★★★ (< 1 MB per 100 MB file) |
| **S3-native** | ★☆☆☆☆ (needs SSH + s3fs/goofys mount) | ★★★★★ (native) | ★★★★★ (native, pre-signed URLs) |
| **Small files (< 16 KB)** | ★★★★★ (4 KiB blocks match well) | ★★★☆☆ (re-uploads all) | ★★☆☆☆ (CDC chunks too coarse) |
| **Large files (> 1 MB)** | ★★★★★ (excellent dedup) | ★☆☆☆☆ (re-uploads all) | ★★★★★ (excellent dedup, faster) |
| **Zero server infrastructure** | ☆☆☆☆☆ (needs SSH daemon) | ★★★★★ | ★★★★☆ (needs API server, but Lite Mode is self-contained) |
| **Content-addressed storage** | ☆☆☆☆☆ | ☆☆☆☆☆ | ★★★★★ (inherent dedup across files) |

---

## FAQ

### Q: rsync achieves 99% bandwidth savings too. Why not just use it?

**A:** Because rsync requires an SSH-accessible remote host. If your storage target is S3, you'd need to mount S3 as a FUSE filesystem (s3fs, goofys) and run rsync against it. This is:

1. **Fragile** — S3 FUSE mounts have well-documented consistency issues, especially for concurrent writes.
2. **Slow** — Every block comparison requires a round-trip through the FUSE layer to S3's `HeadObject` API.
3. **Not atomic** — rsync has no concept of "file versions" or transactional commits. A failed sync leaves partial state.

Deltasync bypasses all of this by computing deltas locally and uploading only the changed chunks directly to S3 via pre-signed URLs.

### Q: Your CDC strategy only saves 2.4% on small files. That's terrible.

**A:** Yes, it is. We're honest about this.

CDC with a 16 KiB average chunk size is fundamentally unsuited for files smaller than the chunk size. When a 10 KB file is smaller than one CDC chunk, every boundary check fails and the entire file becomes a single "literal" chunk. There's no deduplication possible.

**Mitigations:**
- For small-file workloads, Deltasync falls back to per-file SHA-256 comparison — if the hash hasn't changed, the file isn't uploaded at all (0 bytes transferred).
- The CLI already implements this: `cached?.last_hash === hash ? skip : upload`.
- For mixed workloads where large files dominate the byte volume, CDC's 90%+ savings on the large files far outweigh the small-file overhead.

### Q: rsync's fixed-block mode is 99% bandwidth-efficient on small files. Why not use fixed blocks?

**A:** We benchmarked it. Fixed blocks are excellent at bandwidth savings but **catastrophically slow** in pure TypeScript:

| Workload | rsync Fixed-Block Time | Deltasync CDC Time | Speedup |
|:---|---:|---:|---:|
| 100 MB, 1% change | 67.7s | 3.3s | **20×** |
| 10 MB small files | 28.3s | 0.5s | **56×** |
| 58 MB mixed | 55.0s | 2.1s | **27×** |

The fixed-block algorithm must slide a window byte-by-byte and compute SHA-256 on every weak-hash hit. CDC scans once to find boundaries and does exactly one hash per chunk. The asymptotic difference is dramatic at scale.

**Note:** With the Rust native addon (NAPI-RS + Rayon), fixed-block performance improves substantially, but CDC remains faster because it does fundamentally less work.

### Q: `aws s3 sync` is faster in wall-clock time. Why would I use Deltasync?

**A:** `aws s3 sync` is faster only because it does zero computation — it just uploads the entire file. On a fast local network, this is fine. But consider the *real* cost:

| Scenario | `aws s3 sync` | Deltasync CDC |
|:---|---:|---:|
| 1 GB file, 1% change, 100 Mbps link | **80 seconds** (uploads 1 GB) | **0.8 seconds** (uploads 10 MB) |
| 1 GB file, 1% change, 10 Mbps link | **800 seconds** (13+ minutes!) | **8 seconds** |
| Monthly S3 PUT cost (100 syncs/day) | ~$15/month | ~$0.15/month |

Deltasync's 3-second compute overhead is negligible compared to the network transfer time it eliminates. The breakeven point is roughly a **50 Mbps link** — below that, delta sync is faster end-to-end.

### Q: What about deduplication across different files?

**A:** This is where Deltasync has a unique advantage over both rsync and `aws s3 sync`. Because chunks are stored by their SHA-256 hash (content-addressed), if two different files share identical chunks, those chunks are stored once in S3. rsync has no concept of cross-file deduplication.

### Q: What are Deltasync's honest limitations?

1. **Small files (< chunk size):** CDC doesn't help. We fall back to hash-based skip, which is still better than re-uploading, but not as good as rsync's fine-grained blocks.
2. **First upload:** No prior version exists, so no delta is possible. The first push is always a full upload.
3. **CPU overhead:** Delta computation adds 1–3 seconds per 100 MB. On a very fast network (1 Gbps+), this overhead may exceed the transfer time savings for small changes.
4. **Single-direction (MVP):** The current Lite Mode only supports push (local → S3). Bidirectional sync with conflict resolution is post-MVP.
5. **No real-time watching:** The CLI is invoked manually. File watching and continuous sync are out of scope for v1.

---

## Bottom Line

| Your Workload | Use This |
|:---|:---|
| Large files to S3, slow/metered network | **Deltasync** — saves 90–99% bandwidth |
| Small files, fast LAN, SSH available | **rsync** — mature, proven, fine-grained |
| Any files, no delta needed, fast network | **aws s3 sync** — simplest, zero overhead |
| Mixed large+small, S3-native, no SSH | **Deltasync** — best overall tradeoff |

---

*Benchmark data: [`docs/BENCHMARK_RESULTS.md`](BENCHMARK_RESULTS.md) · [`benchmarks/results.json`](../benchmarks/results.json)*
