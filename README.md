# Deltasync — Delta-Based File Synchronization Engine

Send only the bytes that changed.

Deltasync is a high-performance delta-based file synchronization engine. It uses a rolling Adler-32 hash to detect shifted content in O(1) per byte, then verifies matches with SHA-256. This means a 4 GB file with a 1% edit transfers in 40 MB, not 4 GB.

## 🚀 Key Features & Production Architecture

*   **Rsync Algorithm Implementation**: Uses a two-level match (Adler-32 + SHA-256) to perform rolling hash block deduplication. Hashes are fully unit-tested via Vitest to guarantee zero false positives.
*   **Zero-Copy Native FFI (NAPI-RS + Rayon)**: CDC chunking, Adler-32, and SHA-256 hashing are offloaded to a Rust native addon via NAPI-RS. Computation runs on Rayon's thread pool, keeping the Node.js event loop 100% unblocked. Falls back gracefully to TypeScript if the native binary isn't compiled.
*   **Full-Stack Web Interface (TanStack Start)**: A complete web UI featuring robust Authentication, a functional Dashboard, API Keys management, Background Jobs monitor, File Management, and an interactive Web Playground for testing and visualizing the sync algorithm.
*   **Reference CLI (`deltasync`)**: A fully functional Node.js CLI to push, pull, and check status, utilizing a local SQLite cache (`.deltasync/cache.db`) to track file states and skip unmodified uploads entirely.
*   **Pre-Signed Upload Architecture (v2)**: Two-phase upload handshake — clients hash locally, negotiate with the server, then upload missing chunks directly to S3 via pre-signed URLs. The server's network interface is completely bypassed for binary data.
*   **Transactional Outbox Pattern**: Events (e.g., `FILE_VERSION_CREATED`) are emitted atomically within DB transactions. A background dispatcher polls the outbox and feeds BullMQ, guaranteeing at-least-once delivery without distributed transactions.
*   **Event-Driven Background Workers**: Background jobs run via BullMQ for heavy operations: `verify-chunks` (checking S3 integrity after upload), `cleanup-file` (cascading deletes), and `run-gc`.
*   **Offline Garbage Collection (Roaring Bitmap Strategy)**: GC streams manifests to build a prefix-bucketed compressed hash set (simulating Roaring Bitmaps for O(1) memory), then reconciles against S3 Inventory Reports (or ListObjectsV2) with zero database load during reconciliation.
*   **FlatBuffer Wire Format (DSO2)**: Zero-copy binary manifest codec defined in `shared/ops.fbs.ts`. Operations are read directly from the buffer at computed offsets — no JSON parsing, no memory allocation. Backward compatible with DSO1 and JSON formats.
*   **Infrastructure as Code (IaC)**: Includes a Terraform definition (`infrastructure/main.tf`) to reproducibly provision S3 buckets (with SSE-KMS encryption), ECS clusters, and RDS PostgreSQL 16 databases.
*   **Containerized Compute Layer**: Ready-to-deploy multistage `Dockerfile` specifically optimized for the Bun/Vite/TanStack environment.
*   **Automated CI/CD Pipeline**: GitHub Actions workflow (`.github/workflows/ci.yml`) automatically spins up testing services (PostgreSQL/Redis), runs Vitest suites, builds the Docker image, pushes to ECR, and triggers blue/green deployments to AWS ECS.
*   **Distributed Rate Limiting**: Centralized Redis-backed rate limiter (`ioredis` / `server/s3-limiter.ts`) restricts clients to 60 requests/minute consistently across a multi-node fleet.
*   **Security Hardening**:
    *   Strict `JWT_SECRET` requirement (halts startup if missing) powered by `jose`.
    *   Zod-level logical path traversal prevention (`../`, `./`, `/`).
    *   Strict payload size caps (500MB limit).

## 🛠 Tech Stack

*   **Frontend**: React 19, Tailwind CSS 4, Radix UI, Lucide React, Recharts
*   **Framework/Routing**: TanStack Start & TanStack Router (Full-Stack SSR)
*   **Backend Runtime**: Node.js (via Vite Dev Server / TanStack Server)
*   **Native Layer**: Rust (NAPI-RS + Rayon thread pool)
*   **Database**: PostgreSQL 16, Drizzle ORM
*   **Storage**: S3-Compatible Object Storage (`@aws-sdk/client-s3`)
*   **Message Queue**: Redis & BullMQ
*   **Wire Format**: FlatBuffer-style DSO2 binary protocol (`ops.fbs.ts`)
*   **Testing**: Vitest
*   **Infrastructure**: Docker, Terraform, GitHub Actions

## 📦 Prerequisites

*   Node.js 22+
*   PostgreSQL running locally or remotely
*   Redis server (for Rate Limiting and BullMQ)
*   An S3-compatible object storage bucket
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
    Create a `.env` file in the root directory:
    ```env
    # Database Configuration
    DATABASE_URL=postgres://user:password@localhost:5432/deltasync

    # Redis Configuration (BullMQ & Rate Limiting)
    REDIS_URL=redis://localhost:6379

    # Security (Must be set, no default fallback)
    JWT_SECRET=your_super_secret_jwt_string

    # S3 Object Storage Configuration
    S3_REGION=auto
    S3_ENDPOINT=https://your-s3-endpoint.com
    S3_ACCESS_KEY_ID=your_access_key
    S3_SECRET_ACCESS_KEY=your_secret_key
    S3_BUCKET_NAME=deltasync-blocks
    S3_UPLOAD_CONCURRENCY=12

    # S3 Inventory (for offline GC — optional)
    S3_INVENTORY_BUCKET=
    S3_INVENTORY_KEY=

    # Outbox Dispatcher
    OUTBOX_POLL_MS=2000

    # Observability
    LOG_LEVEL=info
    NODE_ENV=development
    ```

5.  **Run Database Migrations:**
    ```bash
    npx drizzle-kit push
    ```

6.  **Start the Development Services:**
    You'll need multiple terminal tabs for full functionality:
    ```bash
    # Tab 1: Main API Server (Full-Stack UI & API)
    npm run dev

    # Tab 2: Outbox Event Dispatcher
    npx tsx --env-file=.env server/outbox-dispatcher.ts

    # Tab 3: BullMQ Background Worker
    npx tsx --env-file=.env server/worker.ts
    ```
    The application UI will be available at `http://localhost:5000/`.

7.  **Setting up the CLI (Optional):**
    ```bash
    cd cli
    npm install
    npm run build
    npm link
    # You can now use `deltasync init`, `deltasync push`, etc.
    ```

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
*   **Event-Driven Workers**: The transactional outbox guarantees that background jobs (chunk verification, GC, future RAG indexing) are never lost, even if Redis is temporarily unavailable.
*   **FlatBuffer Manifests**: Operation manifests use a zero-copy binary format (DSO2) where fields are read at computed offsets — 100MB manifests are usable with zero CPU parsing overhead.
*   **Offline GC**: Garbage collection uses compressed hash sets (simulating Roaring Bitmaps) and S3 Inventory Reports, keeping the transactional database at zero load during reconciliation.
