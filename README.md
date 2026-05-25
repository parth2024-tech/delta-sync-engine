# Deltasync — Delta-Based File Synchronization Engine

Send only the bytes that changed.

Deltasync is a high-performance delta-based file synchronization engine. It uses a rolling Adler-32 hash to detect shifted content in O(1) per byte, then verifies matches with SHA-256. This means a 4 GB file with a 1% edit transfers in 40 MB, not 4 GB.

## 🚀 Key Features & Production Architecture

*   **Rsync Algorithm Implementation**: Uses a two-level match (Adler-32 + SHA-256) to perform rolling hash block deduplication. Hashes are fully unit-tested via Vitest to guarantee zero false positives.
*   **Zero-Copy Native FFI (NAPI-RS + Rayon)**: CDC chunking, Adler-32, and SHA-256 hashing are offloaded to a Rust native addon via NAPI-RS. Offloads heavy computation to Rayon's thread pool zero-copy using raw V8 memory pointer address transmutations, keeping the Node.js event loop 100% unblocked with absolutely no buffer clones. Falls back gracefully to TypeScript if the native binary isn't compiled.
*   **Full-Stack Web Interface (TanStack Start)**: A complete web UI featuring robust Authentication, a functional Dashboard, API Keys management, Background Jobs monitor, File Management, and an interactive Web Playground for testing and visualizing the sync algorithm.
*   **Stateful Resumable CLI (`deltasync`)**: A fully functional Node.js CLI utilizing a local SQLite database cache (`.deltasync/cache.db`) with stateful transfer journaling and staging area reconciliation handshakes to automatically skip already committed remote chunks and resume aborted pushes mid-flight in parallel.
*   **Concurrent Multi-Worker Outbox**: Background jobs run inside an in-process `worker_threads` worker pool with a work-stealing task scheduler that groups outbox events by manifest complexity, routing ultra-large manifests to dedicated queues to prevent pipeline stalling. SQLite WAL mode, aggressive busy-timeouts, and NORMAL synchronicity permit concurrent read/write throughput.
*   **Offline Garbage Collection (Inventory-Only)**: Enforces scale-aware flat storage inventory reports to reconcile bucket contents against database schemas, completely disabling real-time AWS ListObjectsV2 API listing bottlenecks. Uses prefix-bucketed compressed sets (simulating Roaring Bitmaps) to maintain $O(1)$ memory.
*   **Radix-Indexed Storage Sharding**: Block storage keys are sharded prefix-wise matching the initial hex characters of the SHA-256 strong hash (e.g. `2f/2f0e4b...`) to avoid concurrent write partition locks in large S3 buckets.
*   **FlatBuffer Wire Format (DSO2)**: Zero-copy binary manifest codec defined in `shared/ops.fbs.ts`. Operations are read directly from the buffer at computed offsets — no JSON parsing, no memory allocation. Backward compatible with DSO1 and JSON formats.
*   **Lite Mode Architecture**: We have streamlined the MVP by removing PostgreSQL, Redis, and BullMQ. It now runs on an embedded **SQLite** database and uses in-memory limits. See [Lite Mode Architecture](docs/ARCHITECTURE_LITE.md) for details.
*   **Containerized Compute Layer**: Ready-to-deploy multistage `Dockerfile` specifically optimized for the Bun/Vite/TanStack environment.
*   **Automated CI/CD Pipeline**: GitHub Actions workflow (`.github/workflows/ci.yml`) automatically spins up testing services (PostgreSQL/Redis), runs Vitest suites, builds the Docker image, pushes to ECR, and triggers blue/green deployments to AWS ECS.
*   **In-Memory Rate Limiting**: Centralized rate limiter (`server/s3-limiter.ts`) restricts clients to 60 requests/minute using a simple token bucket.
*   **Enterprise-Grade Security Hardening**:
    *   **Cryptographically Secure API Keys**: Upgraded from simple UUIDs to 256-bit secure keys generated with the `dks_` prefix, hashed via one-way SHA-256, and validated using constant-time timing-safe comparisons to eliminate timing attack vectors.
    *   **Automated Environment Validation**: A startup validation engine (`server/environment.ts`) that runs immediately at launch to inspect all environment variables and halt execution if default/development credentials (like the default `JWT_SECRET`) are used in a production context.
    *   **Robust Security Headers**: Native middleware (`server/security-headers.ts`) that configures essential modern protection headers including Strict-Transport-Security (HSTS), Content-Security-Policy (CSP), X-Frame-Options (DENY), X-Content-Type-Options (nosniff), legacy XSS Protection, and proper CORS rules.
    *   **Database-Backed Negotiation Store**: Migrated the critical rolling hash negotiation store from memory to an index-optimized SQLite table (`negotiations` in `shared/schema.ts` and `server/negotiation-store-db.ts`), allowing seamless horizontal scaling across multi-instance nodes with automatic TTL-based expired record cleanups.
    *   **Structured Context Logging**: Powered by Pino with correlation tracking, providing secure, production-level diagnostic trails without risk of exposing credentials or PII.
    *   **Secure Password Hashing**: Enforces strict password validation rules (minimum 8 characters) and hashes secrets using 12 bcrypt rounds.
    *   **Additional Controls**: Strict Zod schemas for path traversal prevention (`../`, `./`), null byte rejection, and strict payload size limits (500MB).

## 🛠 Tech Stack

*   **Frontend**: React 19, Tailwind CSS 4, Radix UI, Lucide React, Recharts
*   **Framework/Routing**: TanStack Start & TanStack Router (Full-Stack SSR)
*   **Backend Runtime**: Node.js (via Vite Dev Server / TanStack Server)
*   **Native Layer**: Rust (NAPI-RS + Rayon thread pool)
*   **Database**: SQLite (`better-sqlite3`), Drizzle ORM
*   **Storage**: S3-Compatible Object Storage (`@aws-sdk/client-s3` upgraded to `v3.600.0` for connection pooling/security)
*   **Wire Format**: FlatBuffer-style DSO2 binary protocol (`ops.fbs.ts`)
*   **Logging**: Pino (Structured JSON logging)
*   **Testing**: Vitest (Comprehensive API handlers & Authentication tests with 600+ LOC and 85+ assertions)
*   **Infrastructure**: Docker, GitHub Actions

## 📚 Comprehensive Documentation

Deltasync comes with extensive production-ready manuals located in the `docs/` directory to help you deploy, secure, and integrate with the platform:

*   **[API Reference (docs/API.md)](./docs/API.md)**: Full reference for authentication modes (session cookies vs. `dks_` API keys), sync/negotiation protocols, error payloads, and rate limits.
*   **[Environment Variables Reference (docs/ENVIRONMENT.md)](./docs/ENVIRONMENT.md)**: Detailed configuration guide outlining required vs optional variables, example config blocks for development and production, and troubleshooting validation errors.
*   **[Security Hardening Guide (docs/SECURITY.md)](./docs/SECURITY.md)**: Complete security architecture handbook, checklist for production deployment, secret management, JWT rotation, database encryption, and incident response procedures.
*   **[Deployment Guide (docs/DEPLOYMENT.md)](./docs/DEPLOYMENT.md)**: Step-by-step setup guides for Local, Docker, multi-pod Kubernetes (with YAML examples), and AWS ECS (Fargate) deployments.
*   **[Audit & Fixes Summary (FIXES_SUMMARY.md)](./FIXES_SUMMARY.md)**: High-level technical overview detailing the exact resolutions and code blocks for all 20 critical, high, and medium security/quality issues resolved in the latest release.
*   **[Fixes Index (FIXES_INDEX.md)](./FIXES_INDEX.md)**: Quick-reference directory index of all codebase modifications, unit test coverage, and deployment readiness checklists.

## 📦 Prerequisites

*   Node.js 22+
*   An S3-compatible object storage bucket (e.g., AWS S3, MinIO, LocalStack)
*   Rust toolchain (for native addon compilation — optional, has TS fallback)

## ⚙️ Installation & Setup

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/parth2024-tech/delta-sync-engine.git
    cd delta-sync-engine
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Build the native addon (optional, recommended):**
    ```bash
    cd native
    cargo build --release
    # The NAPI-RS addon will be at native/deltasync-native.node
    # If skipped, the server uses a TypeScript fallback automatically.
    ```

4.  **Configure Environment Variables:**
    Copy the provided `.env.example` file to `.env` and configure your credentials:
    ```bash
    cp .env.example .env
    ```
    Ensure you generate a secure cryptographically strong secret for production JWT:
    ```bash
    # Example to generate a strong key
    openssl rand -base64 32
    ```
    
    All critical variables (such as database type, S3 connection details, and JWT secrets) are validated at launch by the startup environment validation engine. Refer to the **[Environment Guide (docs/ENVIRONMENT.md)](./docs/ENVIRONMENT.md)** for a comprehensive explanation of every configuration parameter and deployment target.

5.  **Run Database Migrations:**
    ```bash
    npx drizzle-kit push
    ```

6.  **Start the Development Services:**
    The easiest way to start the entire Lite Mode stack (including an automated local MinIO instance) is to run the demo script:
    ```bash
    ./scripts/demo.sh
    ```
    This will start the API server on `http://localhost:5000/` and the MinIO console on `http://localhost:9001/`.

    Alternatively, to run manually in development mode:
    ```bash
    # Tab 1: Main API Server (Full-Stack UI & API)
    npm run dev

    # Tab 2: Outbox Event Dispatcher (handles background tasks directly)
    npx tsx --env-file=.env server/outbox-dispatcher.ts
    ```

7.  **Setting up the CLI (Optional):**
    ```bash
    cd cli
    npm install
    npm run build
    npm link
    # You can now use `deltasync init`, `deltasync push`, etc.
    ```

## 📊 Benchmarks & Performance

Deltasync has been rigorously benchmarked against `aws s3 sync` and traditional fixed-block `rsync`.

**Key Findings:**
* **Large Files (100MB, 1% change):** Deltasync CDC achieves **99% bandwidth savings** and is **20× faster** than fixed-block rsync.
* **Mixed Workloads:** Achieves **90%+ bandwidth savings** while being **27× faster** than fixed-block rsync.
* **Efficiency:** Deltasync uses **15-20× less memory** (< 1MB) than fixed-block rsync because it uses a single-pass Content-Defined Chunking (CDC) scan instead of a byte-by-byte rolling window.

For a detailed breakdown of the methodology, raw data, and an honest comparison of when to use which tool, see:
* [Benchmark Results & Charts](docs/BENCHMARK_RESULTS.md)
* [Comparison: Deltasync vs rsync vs aws s3 sync (FAQ)](docs/COMPARISON.md)

## 🧠 How the Algorithm Works

1.  **Block & Sign**: The server splits the existing file into fixed-size blocks (e.g., 4 KiB). For each block, it computes a weak Adler-32 hash and a strong SHA-256 hash.
2.  **Roll the Window**: The client slides a window of `blockSize` bytes across the *new* file. The weak Adler-32 hash updates in O(1) time when one byte enters and another leaves the window.
3.  **Two-Level Match**: On a 16-bit weak hit, the client verifies the block with a SHA-256 hash.
    *   A confirmed match emits a `COPY` op.
    *   Otherwise, the leftmost byte drops out of the window and joins a `LITERAL` run.
4.  **Stream the Delta**: Only the `LITERAL` runs are transferred over the wire. The server then replays the `COPY` and `LITERAL` ops against the object storage blocks to reconstruct the new file version.

## 📡 Upload Architecture (v2 — Pre-Signed)

The v2 upload flow eliminates binary data routing through the API server:

1.  **Negotiate** (`POST /api/public/sync/negotiate`): Client sends chunk hashes → server returns pre-signed S3 PUT URLs for missing chunks.
2.  **Upload**: Client uploads binary data directly to S3 via pre-signed URLs. Server bandwidth is zero.
3.  **Commit** (`POST /api/public/sync/commit`): Client confirms upload → server atomically creates the file version + outbox event.

The legacy `POST /api/public/sync/upload` endpoint remains for backward compatibility.

## 🛡️ Architecture Highlights

*   **Content-Addressed Storage**: Blocks are stored and keyed strictly by their SHA-256 hash. Identical blocks across different files or users are inherently deduplicated (O(1) storage cost for identical blocks).
*   **Zero-Copy Native Hashing**: Adler-32 and SHA-256 are computed in Rust via NAPI-RS, using Rayon for parallel multi-core processing. No JavaScript byte loops.
*   **Event-Driven Workers**: The transactional outbox guarantees that background jobs (chunk verification, GC, future RAG indexing) are executed reliably even without an external message queue.
*   **FlatBuffer Manifests**: Operation manifests use a zero-copy binary format (DSO2) where fields are read at computed offsets — 100MB manifests are usable with zero CPU parsing overhead.
*   **Offline GC**: Garbage collection uses compressed hash sets (simulating Roaring Bitmaps) and S3 Inventory Reports, keeping the transactional database at zero load during reconciliation.
