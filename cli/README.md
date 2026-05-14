# Deltasync CLI

Reference CLI for the Deltasync delta-based file sync engine.

## Install

```bash
cd cli
npm install
npm run build
npm link          # makes `deltasync` available globally
```

## Quickstart

```bash
# 1. Initialise (run once per project directory)
deltasync init
# > Server URL [http://localhost:5000]:
# > API key (dks_…): dks_<your-key-from-dashboard>

# 2. Push a file
deltasync push report.pdf
# ✓ pushed — saved 3.8 MB (95%)

# 3. Push again after a tiny edit — only changed bytes transfer
deltasync push report.pdf
# delta: 1 literal, 1023 copy ops
# ✓ pushed — saved 3.9 MB (99%)

# 4. Pull (optionally a specific version)
deltasync pull report.pdf
deltasync pull report.pdf --version 1

# 5. Check sync status
deltasync status
```

## Commands

| Command | Description |
|---------|-------------|
| `deltasync init` | Initialise config in `.deltasync/` |
| `deltasync push <file>` | Upload changed bytes to server |
| `deltasync pull <file> [--version N]` | Download file (or specific version) |
| `deltasync status` | Compare local vs server |

## How it works

1. **push**: reads local file → fetches server block signatures → runs Adler-32 rolling-hash delta → sends only changed bytes (`literal` ops) + references to unchanged blocks (`copy` ops).
2. **pull**: downloads the reconstructed file as a byte stream.
3. **Local cache** (`.deltasync/cache.db`): tracks last mtime, size, and SHA-256 so unchanged files skip re-upload entirely.
