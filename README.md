# Deltasync — Delta-Based File Synchronization Engine

Send only the bytes that changed.

Deltasync is a high-performance delta-based file synchronization engine. It uses a rolling Adler-32 hash to detect shifted content in O(1) per byte, then verifies matches with SHA-256. This means a 4 GB file with a 1% edit transfers in 40 MB, not 4 GB.

## 🚀 Key Features & Production Optimizations

*   **Rsync Algorithm Implementation**: Uses a two-level match (Adler-32 + SHA-256) to perform rolling hash block deduplication.
*   **Object Storage Backend (S3)**: Physical block data is stored in any S3-compatible object storage layer (AWS S3, Cloudflare R2, or MinIO) for horizontal scalability and persistent durability across container restarts.
*   **Streaming Multipart Uploads**: Eliminates in-memory buffering. Literal block byte chunks are piped directly to object storage as a stream (`PassThrough` + `@aws-sdk/lib-storage`), drastically reducing memory footprint and preventing OOM crashes on gigabyte-sized files.
*   **Database Transaction Scaling**: Uses array-based batch inserts via Drizzle ORM (chunked into 500 records) to eliminate N+1 query bottlenecks during large block transactions.
*   **PostgreSQL Connection Pooling**: Configured `pg` connection pool with explicit limits to gracefully handle traffic spikes and prevent database exhaustion.
*   **Security Hardening**:
    *   Fails fast on missing secrets (strict `JWT_SECRET` requirement, halting startup if missing).
    *   In-memory rate limiting applied at the upload middleware layer (60 requests/min).
    *   Strict payload size caps (500MB limit).
*   **Observability**: Fully structured JSON logging using `pino` to enable effective tracing and integration with Datadog/CloudWatch.

## 🛠 Tech Stack

*   **Frontend**: React 19, Tailwind CSS 4, Radix UI
*   **Framework/Routing**: TanStack Start & TanStack Router
*   **Backend Runtime**: Node.js (Vite Dev Server)
*   **Database**: PostgreSQL, Drizzle ORM
*   **Storage**: S3-Compatible Object Storage (`@aws-sdk/client-s3`)
*   **Logging**: Pino Structured Logging

## 📦 Prerequisites

*   Node.js 22+ (or Bun)
*   PostgreSQL running locally or remotely
*   An S3-compatible object storage bucket (e.g., AWS S3, Cloudflare R2, MinIO)

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
    Push the Drizzle schema to your PostgreSQL database.
    ```bash
    npx drizzle-kit push
    ```

5.  **Start the Development Server:**
    ```bash
    npm run dev
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
