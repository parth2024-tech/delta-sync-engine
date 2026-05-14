# Deltasync — Delta-Based File Synchronization Engine

Send only the bytes that changed.

Deltasync is a high-performance delta-based file synchronization engine. It uses a rolling Adler-32 hash to detect shifted content in O(1) per byte, then verifies matches with SHA-256. This means a 4 GB file with a 1% edit transfers in 40 MB, not 4 GB.

## 🚀 Key Features & Production Architecture

*   **Rsync Algorithm Implementation**: Uses a two-level match (Adler-32 + SHA-256) to perform rolling hash block deduplication. Hashes are fully unit-tested via Vitest to guarantee zero false positives.
*   **Infrastructure as Code (IaC)**: Includes a Terraform definition (`infrastructure/main.tf`) to reproducibly provision S3 buckets (with SSE-KMS encryption), ECS clusters, and RDS PostgreSQL databases.
*   **Containerized Compute Layer**: Ready-to-deploy multistage `Dockerfile` specifically optimized for the Bun/Vite/TanStack environment.
*   **Automated CI/CD Pipeline**: GitHub Actions workflow automatically spins up testing services (PostgreSQL/Redis), runs Vitest suites, builds the Docker image, and triggers blue/green deployments to AWS ECS.
*   **Decoupled Asynchronous Workers**: Uses **BullMQ** running on a separate container (`server/worker.ts`) to handle heavy background processing, isolating compute-intensive tasks from the HTTP API.
*   **Streaming Multipart Uploads**: Eliminates in-memory buffering. Literal block byte chunks are piped directly to S3 as a stream (`PassThrough` + `@aws-sdk/lib-storage`), preventing OOM crashes on massive files.
*   **Database Transaction Scaling**: Array-based batch inserts via Drizzle ORM (chunked into 500 records) eliminate N+1 query bottlenecks. Uses optimistic locking to gracefully handle concurrent sync race conditions (PostgreSQL 23505 unique constraints).
*   **Distributed Rate Limiting**: Centralized Redis-backed rate limiter (`ioredis`) restricts clients to 60 requests/minute consistently across a multi-node fleet.
*   **Automated Garbage Collection & Maintenance**: Includes dedicated cron scripts (`server/gc.ts` & `server/cleanup.ts`) to continuously purge orphaned S3 blobs and prune stale `sync_jobs` logs older than 30 days.
*   **Security Hardening**:
    *   Strict `JWT_SECRET` requirement (halts startup if missing).
    *   Zod-level logical path traversal prevention (`../`, `./`, `/`).
    *   Strict payload size caps (500MB limit).
*   **Observability & Health**: Fully structured JSON logging using `pino` and a dedicated `GET /api/health` probe endpoint for Load Balancer liveness checks.

## 🛠 Tech Stack

*   **Frontend**: React 19, Tailwind CSS 4, Radix UI
*   **Framework/Routing**: TanStack Start & TanStack Router
*   **Backend Runtime**: Node.js (Vite Dev Server)
*   **Database**: PostgreSQL, Drizzle ORM
*   **Storage**: S3-Compatible Object Storage (`@aws-sdk/client-s3`)
*   **Message Queue**: Redis & BullMQ
*   **Testing**: Vitest
*   **Infrastructure**: Docker, Terraform, GitHub Actions

## 📦 Prerequisites

*   Node.js 22+
*   PostgreSQL running locally or remotely
*   Redis server (for Rate Limiting and BullMQ)
*   An S3-compatible object storage bucket

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

3.  **Configure Environment Variables:**
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

    # Observability
    LOG_LEVEL=info
    NODE_ENV=development
    ```

4.  **Run Database Migrations:**
    ```bash
    npx drizzle-kit push
    ```

5.  **Start the Development Services:**
    You'll need multiple terminal tabs for full functionality:
    ```bash
    # Tab 1: Main API Server
    npm run dev
    
    # Tab 2: BullMQ Background Worker
    npx tsx server/worker.ts
    ```
    The application will be available at `http://localhost:5000/`.

## 🧠 How the Algorithm Works

1.  **Block & Sign**: The server splits the existing file into fixed-size blocks (e.g., 4 KiB). For each block, it computes a weak Adler-32 hash and a strong SHA-256 hash.
2.  **Roll the Window**: The client slides a window of `blockSize` bytes across the *new* file. The weak Adler-32 hash updates in O(1) time when one byte enters and another leaves the window.
3.  **Two-Level Match**: On a 16-bit weak hit, the client verifies the block with a SHA-256 hash.
    *   A confirmed match emits a `COPY` op.
    *   Otherwise, the leftmost byte drops out of the window and joins a `LITERAL` run.
4.  **Stream the Delta**: Only the `LITERAL` runs are transferred over the wire. The server then replays the `COPY` and `LITERAL` ops against the object storage blocks to reconstruct the new file version.

## 🛡️ Architecture Highlights

*   **Content-Addressed Storage**: Blocks are stored and keyed strictly by their SHA-256 hash. Identical blocks across different files or users are inherently deduplicated (O(1) storage cost for identical blocks).
*   **Streaming S3 PassThrough**: Literal uploads are streamed immediately from the incoming request body through a `PassThrough` stream directly into the S3 bucket. Adler-32 and SHA-256 hashes are computed incrementally in-flight, meaning massive files can be uploaded without ever touching the local disk or blowing up application memory.
