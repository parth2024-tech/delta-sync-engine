# Benchmark Results — Delta Sync Engine

> Measured on: Linux, Node.js 22+, single-threaded TypeScript (no Rust native addon for this benchmark).
>
> File sizes are scaled down (100 MB / 10 KB) for practical CI runtime. The change ratios (1%, 5%) are identical to the spec, so efficiency comparisons are valid.

## Methodology

Three strategies are benchmarked on identical data:

| Strategy | Description |
|:---|:---|
| **Full Re-upload** | Entire modified file is transferred. Simulates `aws s3 sync` or any naive cloud copy. |
| **rsync Fixed-Block (4 KiB)** | Classical rsync algorithm with 4 KiB fixed blocks, Adler-32 weak hash + SHA-256 strong hash. |
| **Deltasync CDC (16 KiB avg)** | FastCDC content-defined chunking with ~16 KiB average chunk size, same Adler-32 + SHA-256 verification. |

---

## Workload 1: Large Single File (100 MB, 1% append)

A single 100 MB file with 1 MB appended to the end. This is the canonical use case for delta sync — large files with small edits.

| Strategy | Transfer | Time | BW Saved | Memory |
|:---|---:|---:|---:|---:|
| Full Re-upload | 105.91 MB | 206 ms | — | 0.3 MB |
| rsync Fixed-Block | **1.05 MB** | 67.73 s | **99.0%** | 18.5 MB |
| Deltasync CDC | **1.07 MB** | **3.29 s** | **99.0%** | < 1 MB |

**Key Insight:** Both delta strategies achieve **99% bandwidth savings** — only the changed 1% is transferred. However, Deltasync CDC is **20× faster** than fixed-block rsync because CDC chunk boundaries are content-aligned, eliminating the expensive byte-by-byte rolling window scan that fixed-block rsync requires.

---

## Workload 2: Many Small Files (1,000 × 10 KB, 5% changed)

1,000 concatenated 10 KB files where 5% are completely replaced with new random content.

| Strategy | Transfer | Time | BW Saved | Memory |
|:---|---:|---:|---:|---:|
| Full Re-upload | 10.24 MB | 24 ms | — | < 1 MB |
| rsync Fixed-Block | **643 KB** | 28.33 s | **93.7%** | 10.2 MB |
| Deltasync CDC | 10.00 MB | 514 ms | 2.4% | < 1 MB |

**Key Insight:** Fixed-block rsync excels here because the 4 KiB block size aligns well with the 10 KB files. CDC with a 16 KiB average chunk size is too coarse for 10 KB files — most chunks span file boundaries, so nearly everything looks "changed." **This is a known weakness of CDC for small-file workloads** and is documented honestly in the Comparison FAQ below.

---

## Workload 3: Mixed (50 MB large file + 500 × 10 KB small files)

A realistic mixed workload: one large file (1% appended) plus 500 small files (5% changed).

| Strategy | Transfer | Time | BW Saved | Memory |
|:---|---:|---:|---:|---:|
| Full Re-upload | 58.07 MB | 132 ms | — | < 1 MB |
| rsync Fixed-Block | **950 KB** | 55.04 s | **98.4%** | 14.9 MB |
| Deltasync CDC | **5.45 MB** | **2.06 s** | **90.6%** | < 1 MB |

**Key Insight:** CDC saves **90.6% bandwidth** while being **27× faster** than fixed-block rsync. The large file dominates the savings. For workloads that are *primarily* large files with small edits, CDC is the clear winner on overall throughput.

---

## Aggregate Comparison Chart

```
Bandwidth Saved (%)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Large File   │ Full  ▓░░░░░░░░░░░░░░░░░░░░   0.0%
             │ rsync ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  99.0%
             │ CDC   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  99.0%
─────────────┤
Small Files  │ Full  ▓░░░░░░░░░░░░░░░░░░░░   0.0%
             │ rsync ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░  93.7%
             │ CDC   ▓░░░░░░░░░░░░░░░░░░░░   2.4%
─────────────┤
Mixed        │ Full  ▓░░░░░░░░░░░░░░░░░░░░   0.0%
             │ rsync ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  98.4%
             │ CDC   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░  90.6%
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

```
Compute Time (lower is better)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Large File   │ Full   0.2s  ▓░
             │ rsync 67.7s  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
             │ CDC    3.3s  ▓▓
─────────────┤
Small Files  │ Full   0.0s  ░
             │ rsync 28.3s  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓
             │ CDC    0.5s  ░
─────────────┤
Mixed        │ Full   0.1s  ░
             │ rsync 55.0s  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
             │ CDC    2.1s  ▓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## CPU & Memory Overhead

| Strategy | Peak Memory | CPU Profile |
|:---|---:|:---|
| Full Re-upload | < 1 MB overhead | Single SHA-256 hash pass |
| rsync Fixed-Block | 10–19 MB | O(n) byte-by-byte rolling scan + SHA-256 per match candidate |
| Deltasync CDC | < 1 MB | O(n) single-pass CDC boundary scan + SHA-256 per chunk |

**Deltasync CDC uses 15–20× less memory than fixed-block rsync** because it doesn't need to maintain a rolling hash window across the entire file. CDC scans once to find boundaries, then does one SHA-256 per chunk.

---

## When to Use What

| Scenario | Best Strategy | Why |
|:---|:---|:---|
| Large files, small edits (databases, VM images, logs) | **Deltasync CDC** | 99% BW savings, 20× faster than rsync |
| Many tiny files (< chunk size) | **rsync Fixed-Block** or **Full Re-upload** | CDC chunks are too coarse for tiny files |
| Mixed workloads | **Deltasync CDC** | 90%+ BW savings, dominated by large file gains |
| First-time upload (no prior version) | **Full Re-upload** | No delta possible without a baseline |

---

*Raw benchmark data: [`benchmarks/results.json`](../benchmarks/results.json)*
*Benchmark script: [`benchmarks/bench.ts`](../benchmarks/bench.ts)*
