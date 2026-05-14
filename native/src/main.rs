//! `deltasync-native` — fast CDC + SHA-256 + binary ops generation (wire-compatible with the TS server).
//!
//! Subcommands:
//!   scan        — benchmark CDC + hashing
//!   pack-delta  — read local file + signatures JSON (API shape), write `ops.bin` + `literals.bin`

use clap::{Parser, Subcommand};
use memmap2::MmapOptions;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
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
    Scan {
        path: PathBuf,
        #[arg(long, default_value = "16384")]
        avg: usize,
    },
    /// Build ops.bin + literals.bin matching `shared/ops-binary.ts` + TS delta (CDC mode).
    PackDelta {
        #[arg(long)]
        local: PathBuf,
        #[arg(long)]
        remote_json: PathBuf,
        #[arg(long)]
        out_ops: PathBuf,
        #[arg(long)]
        out_literals: PathBuf,
        #[arg(long, default_value = "16384")]
        block_size: usize,
        #[arg(long, default_value = "cdc")]
        chunking: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteJson {
    signatures: Vec<RemoteSig>,
    block_size: Option<u32>,
    #[allow(dead_code)]
    chunking: Option<String>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RemoteSig {
    block_index: u32,
    weak_hash: u32,
    strong_hash: String,
    #[allow(dead_code)]
    offset: u32,
    length: u32,
}

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
            cut = (n + 1).min(len);
        }
        ends.push(cut);
        n = cut;
    }
    ends
}

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

fn weak16(w: u32) -> u16 {
    (w & 0xffff) as u16
}

fn sha256_hex(data: &[u8]) -> String {
    let d = Sha256::digest(data);
    hex::encode(d)
}

fn scan(path: &PathBuf, avg: usize) -> Result<(), Box<dyn std::error::Error>> {
    let t0 = Instant::now();
    let file = File::open(path)?;
    let mmap = unsafe { MmapOptions::new().map(&file)? };
    let data: &[u8] = &mmap;

    let mut whole = Sha256::new();
    whole.update(data);
    let file_digest = hex::encode(whole.finalize());

    let ends = cdc_chunk_ends(data, avg);
    let mut prev = 0usize;
    for &end in &ends {
        let mut h = Sha256::new();
        h.update(&data[prev..end]);
        let _ = h.finalize();
        prev = end;
    }

    let elapsed = t0.elapsed();
    println!("path:       {}", path.display());
    println!("bytes:      {}", data.len());
    println!("sha256:     {}", file_digest);
    println!("cdc_chunks: {}", ends.len());
    println!("avg_target: {}", avg);
    println!("wall_ms:    {}", elapsed.as_secs_f64() * 1000.0);
    Ok(())
}

#[derive(Clone, Copy)]
enum OpKind {
    Copy,
    Literal,
}

fn pack_delta(
    local: &PathBuf,
    remote_json: &PathBuf,
    out_ops: &PathBuf,
    out_literals: &PathBuf,
    block_size_arg: usize,
    chunking: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let remote: RemoteJson = serde_json::from_slice(&fs::read(remote_json)?)?;
    let sigs = remote.signatures;
    if chunking != "cdc" {
        return Err("pack-delta currently supports chunking=cdc only (matches TS fast path).".into());
    }

    let file = File::open(local)?;
    let mmap = unsafe { MmapOptions::new().map(&file)? };
    let data: &[u8] = &mmap;

    let block_size = remote
        .block_size
        .map(|v| v as usize)
        .unwrap_or(block_size_arg);

    if sigs.is_empty() {
        let mut ob = Vec::with_capacity(17);
        ob.extend_from_slice(b"DSO1");
        ob.extend_from_slice(&1u32.to_le_bytes());
        ob.push(1u8);
        ob.extend_from_slice(&0u32.to_le_bytes());
        ob.extend_from_slice(&(data.len() as u32).to_le_bytes());
        fs::write(out_ops, ob)?;
        fs::write(out_literals, data)?;
        eprintln!("[pack-delta] new file: 1 literal op, {} bytes", data.len());
        return Ok(());
    }

    let mut buckets: HashMap<u16, Vec<RemoteSig>> = HashMap::new();
    for s in &sigs {
        buckets.entry(weak16(s.weak_hash)).or_default().push(s.clone());
    }

    let ends = cdc_chunk_ends(data, block_size);
    let mut ops: Vec<(OpKind, u32, u32)> = Vec::new();
    let mut lit_buf: Vec<u8> = Vec::new();
    let mut lit_cursor: u32 = 0;
    let mut prev = 0usize;

    for &end in &ends {
        let slice = &data[prev..end];
        let weak = adler32(slice);
        let strong = sha256_hex(slice);
        let slen = slice.len() as u32;

        let mut matched: Option<u32> = None;
        if let Some(cands) = buckets.get(&weak16(weak)) {
            for c in cands {
                if c.weak_hash == weak && c.strong_hash == strong && c.length == slen {
                    matched = Some(c.block_index);
                    break;
                }
            }
        }

        if let Some(bi) = matched {
            ops.push((OpKind::Copy, bi, 0));
        } else {
            let off = lit_cursor;
            let len = slen;
            lit_buf.extend_from_slice(slice);
            ops.push((OpKind::Literal, off, len));
            lit_cursor += len;
        }
        prev = end;
    }

    let mut ob = Vec::with_capacity(8 + ops.len() * 12);
    ob.extend_from_slice(b"DSO1");
    ob.extend_from_slice(&(ops.len() as u32).to_le_bytes());
    for (kind, a, b) in &ops {
        match kind {
            OpKind::Copy => {
                ob.push(0u8);
                ob.extend_from_slice(&a.to_le_bytes());
            }
            OpKind::Literal => {
                ob.push(1u8);
                ob.extend_from_slice(&a.to_le_bytes());
                ob.extend_from_slice(&b.to_le_bytes());
            }
        }
    }

    fs::write(out_ops, ob)?;
    fs::write(out_literals, lit_buf)?;
    eprintln!(
        "[pack-delta] ops={} literals={} bytes (block_size={})",
        ops.len(),
        fs::metadata(out_literals)?.len(),
        block_size
    );
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Scan { path, avg } => scan(&path, avg)?,
        Commands::PackDelta {
            local,
            remote_json,
            out_ops,
            out_literals,
            block_size,
            chunking,
        } => pack_delta(&local, &remote_json, &out_ops, &out_literals, block_size, &chunking)?,
    }
    Ok(())
}
