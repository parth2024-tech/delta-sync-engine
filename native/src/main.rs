//! Native companion CLI: memory-map a file, run content-defined chunking + SHA-256
//! per chunk using release-mode Rust (useful for benchmarking vs Node).
//!
//! Full wire-compatible multipart sync is left to the TypeScript `deltasync` CLI;
//! this tool proves the hashing/chunking path can run at disk bandwidth on large trees.

use clap::{Parser, Subcommand};
use memmap2::MmapOptions;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::path::PathBuf;
use std::time::Instant;

#[derive(Parser)]
#[command(name = "deltasync-native")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Print whole-file SHA-256, chunk count, and timing for CDC + per-chunk hashes
    Scan {
        path: PathBuf,
        /// Target average chunk size (power of two works best)
        #[arg(long, default_value = "16384")]
        avg: usize,
    },
}

/// Same polynomial CDC idea as `shared/fastcdc.ts` (FNV-ish roll + mask cut).
fn cdc_chunk_indices(data: &[u8], avg: usize) -> Vec<(usize, usize)> {
    let min = (avg / 4).max(512);
    let max = (avg * 64).min(4 * 1024 * 1024);
    let mask = avg.next_power_of_two() - 1;
    let mut out = Vec::new();
    let mut n = 0usize;
    while n < data.len() {
        let hard_max = (n + max).min(data.len());
        let min_end = (n + min).min(data.len());
        let mut fp: u32 = 0x811c_9dc5;
        let mut i = n;
        while i < min_end {
            fp = fp.wrapping_mul(0x0100_0193) ^ data[i] as u32;
            i += 1;
        }
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
            cut = (n + 1).min(data.len());
        }
        out.push((n, cut));
        n = cut;
    }
    out
}

fn scan(path: &PathBuf, avg: usize) -> Result<(), Box<dyn std::error::Error>> {
    let t0 = Instant::now();
    let file = File::open(path)?;
    let mmap = unsafe { MmapOptions::new().map(&file)? };
    let data: &[u8] = &mmap;

    let mut whole = Sha256::new();
    whole.update(data);
    let file_digest = hex::encode(whole.finalize());

    let ranges = cdc_chunk_indices(data, avg);
    for (s, e) in &ranges {
        let mut h = Sha256::new();
        h.update(&data[*s..*e]);
        let _ = h.finalize();
    }

    let elapsed = t0.elapsed();
    println!("path:       {}", path.display());
    println!("bytes:      {}", data.len());
    println!("sha256:     {}", file_digest);
    println!("cdc_chunks: {}", ranges.len());
    println!("avg_target: {}", avg);
    println!("wall_ms:    {}", elapsed.as_secs_f64() * 1000.0);
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Scan { path, avg } => scan(&path, avg)?,
    }
    Ok(())
}
