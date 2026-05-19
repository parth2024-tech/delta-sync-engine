#!/usr/bin/env bash
set -e

echo "╔══════════════════════════════════════════════════════════╗"
echo "║     Delta Sync Engine — Benchmark Runner                 ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR/.."

echo "Running benchmark suite..."
echo ""

npx tsx benchmarks/bench.ts

echo ""
echo "Done. Results saved to benchmarks/results.json"
