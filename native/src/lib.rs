//! `deltasync-native` — NAPI-RS bindings for zero-copy, async CDC + hashing.
//!
//! Exports:
//!   - `cdcChunkAndHash(buffer, avgSize)` → Promise<ChunkResult[]>
//!   - `adler32Native(buffer)` → number
//!   - `sha256Native(buffer)` → Promise<string>
//!
//! All heavy computation runs on Rayon thread pool workers, keeping
//! the Node.js event loop 100% unblocked.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rayon::prelude::*;
use sha2::{Digest, Sha256};

// ── Types returned to JavaScript ──────────────────────────────────────────────

/// A single CDC chunk with its boundaries, weak hash (Adler-32), and strong hash (SHA-256 hex).
#[napi(object)]
pub struct ChunkResult {
    pub block_index: u32,
    pub offset: u32,
    pub length: u32,
    pub weak_hash: u32,
    pub strong_hash_hex: String,
}

/// Full result of chunking + hashing an entire buffer.
#[napi(object)]
pub struct CdcHashResult {
    pub chunks: Vec<ChunkResult>,
    pub content_sha256: String,
}

// ── Core algorithms (pure Rust, no Node.js dependencies) ──────────────────────

/// Content-Defined Chunking using FNV-1a rolling fingerprint.
/// Returns exclusive end offsets for each chunk.
fn cdc_chunk_ends(data: &[u8], avg: usize) -> Vec<usize> {
    let min = (avg / 4).max(512);
    let max = (avg * 64).min(4 * 1024 * 1024);
    let mask = avg.next_power_of_two() - 1;
    let mut ends = Vec::new();
    let mut n = 0usize;
    let len = data.len();

    while n < len {
        let hard_max = (n + max).min(len);
        let min_end = (n + min).min(len);
        let mut fp: u32 = 0x811c_9dc5;
        let mut i = n;

        // Skip past minimum chunk size
        while i < min_end {
            fp = fp.wrapping_mul(0x0100_0193) ^ data[i] as u32;
            i += 1;
        }

        // Look for cut point
        let mut cut = hard_max;
        while i < hard_max {
            fp = fp.wrapping_mul(0x0100_0193) ^ data[i] as u32;
            i += 1;
            if (fp as usize & mask) == 0 {
                cut = i;
                break;
            }
        }
        if cut <= n {
            cut = (n + 1).min(len);
        }
        ends.push(cut);
        n = cut;
    }
    ends
}

/// Adler-32 checksum (rsync-compatible weak hash).
fn adler32(data: &[u8]) -> u32 {
    const MOD: u32 = 65521;
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for &byte in data {
        a = (a + byte as u32) % MOD;
        b = (b + a) % MOD;
    }
    ((b << 16) | a) as u32
}

/// SHA-256 hex string.
fn sha256_hex(data: &[u8]) -> String {
    let d = Sha256::digest(data);
    hex::encode(d)
}

// ── NAPI-RS Exported Functions ────────────────────────────────────────────────

/// Synchronous Adler-32 for small buffers (e.g., individual chunk verification).
/// Zero-copy: accepts a reference to the JS Buffer's memory directly.
#[napi]
pub fn adler32_native(data: &[u8]) -> u32 {
    adler32(data)
}

/// Async SHA-256 hashing — offloaded to a Rayon worker thread.
/// Zero-copy: uses pointer casting and handles lifetimes securely using oneshot channels.
#[napi]
pub async fn sha256_native(data: Buffer) -> Result<String> {
    let bytes_ptr = data.as_ptr();
    let bytes_len = data.len();
    
    // Safety: we cast to a static slice to pass to Rayon thread-pool.
    // The main thread Tokio future keeps the `data` Buffer parameter alive in scope
    // and blocks dropping until Rayon resolves, guaranteeing memory safety.
    let static_bytes: &'static [u8] = unsafe {
        std::slice::from_raw_parts(bytes_ptr, bytes_len)
    };

    let (tx, rx) = tokio::sync::oneshot::channel::<String>();

    rayon::spawn(move || {
        let result = sha256_hex(static_bytes);
        let _ = tx.send(result);
    });

    let _keep_alive = data;
    rx.await.map_err(|e| Error::from_reason(format!("Rayon task failed: {}", e)))
}

/// **The primary function**: CDC chunk a buffer, then compute Adler-32 + SHA-256
/// for every chunk — all in parallel on Rayon's thread pool.
///
/// Zero-copy: Raw memory addresses are mapped and handled immutable across thread pools.
#[napi]
pub async fn cdc_chunk_and_hash(data: Buffer, avg_size: Option<u32>) -> Result<CdcHashResult> {
    let bytes_ptr = data.as_ptr();
    let bytes_len = data.len();
    
    // Safety: Cast raw pointer to static slice safely.
    // The main V8 Buffer stays pinned in memory since we hold `data` until Future finishes.
    let static_bytes: &'static [u8] = unsafe {
        std::slice::from_raw_parts(bytes_ptr, bytes_len)
    };
    let avg = avg_size.unwrap_or(16384) as usize;

    let (tx, rx) = tokio::sync::oneshot::channel::<CdcHashResult>();

    rayon::spawn(move || {
        // 1. Compute whole-file SHA-256
        let content_sha256 = sha256_hex(static_bytes);

        // 2. Find CDC chunk boundaries
        let ends = cdc_chunk_ends(static_bytes, avg);

        // 3. Compute Adler-32 + SHA-256 for each chunk IN PARALLEL using Rayon
        let mut ranges: Vec<(usize, usize)> = Vec::with_capacity(ends.len());
        let mut prev = 0usize;
        for &end in &ends {
            ranges.push((prev, end));
            prev = end;
        }

        let chunks: Vec<ChunkResult> = ranges
            .par_iter()
            .enumerate()
            .map(|(idx, &(start, end))| {
                let slice = &static_bytes[start..end];
                ChunkResult {
                    block_index: idx as u32,
                    offset: start as u32,
                    length: (end - start) as u32,
                    weak_hash: adler32(slice),
                    strong_hash_hex: sha256_hex(slice),
                }
            })
            .collect();

        let _ = tx.send(CdcHashResult {
            chunks,
            content_sha256,
        });
    });

    let _keep_alive = data;
    rx.await.map_err(|e| Error::from_reason(format!("Rayon CDC task failed: {}", e)))
}

/// Process a batch of raw literal slices: compute Adler-32 + SHA-256 for each.
/// Used by the upload commit phase to verify chunk integrity.
///
/// Zero-copy: maps raw buffer pointer offsets without cloning.
#[napi]
pub async fn hash_literal_chunks(
    data: Buffer,
    offsets: Vec<u32>,
    lengths: Vec<u32>,
) -> Result<Vec<ChunkResult>> {
    if offsets.len() != lengths.len() {
        return Err(Error::from_reason("offsets and lengths must have equal length"));
    }

    let bytes_ptr = data.as_ptr();
    let bytes_len = data.len();
    
    // Safety: Cast raw pointer to static slice safely.
    // Main buffer is kept alive in Tokio executor scope.
    let static_bytes: &'static [u8] = unsafe {
        std::slice::from_raw_parts(bytes_ptr, bytes_len)
    };
    
    let count = offsets.len();
    let pairs: Vec<(u32, u32)> = offsets.into_iter().zip(lengths).collect();

    let (tx, rx) = tokio::sync::oneshot::channel::<Vec<ChunkResult>>();

    rayon::spawn(move || {
        let results: Vec<ChunkResult> = (0..count)
            .into_par_iter()
            .map(|i| {
                let off = pairs[i].0 as usize;
                let len = pairs[i].1 as usize;
                let end = (off + len).min(static_bytes.len());
                let slice = &static_bytes[off..end];
                ChunkResult {
                    block_index: i as u32,
                    offset: off as u32,
                    length: len as u32,
                    weak_hash: adler32(slice),
                    strong_hash_hex: sha256_hex(slice),
                }
            })
            .collect();

        let _ = tx.send(results);
    });

    let _keep_alive = data;
    rx.await.map_err(|e| Error::from_reason(format!("Rayon hash task failed: {}", e)))
}
