# Lite Mode Architecture (MVP)

The Delta Sync Engine "Lite Mode" is a streamlined architecture designed for the Minimum Viable Product (MVP). It removes complex distributed systems dependencies (like PostgreSQL, Redis, and BullMQ) in favor of local, embedded solutions. This drastically simplifies deployment, especially for single-node development and testing.

## Core Architectural Changes

1. **Embedded Database (SQLite):**
   - **Previous:** PostgreSQL was used for transactional guarantees across multiple nodes.
   - **Lite Mode:** We use `better-sqlite3` as an embedded, highly-performant local database. This removes the need for an external DB server while still providing ACID transactions.

2. **In-Memory Rate Limiting:**
   - **Previous:** Redis (`ioredis`) was used as a centralized token bucket for rate limiting across a fleet.
   - **Lite Mode:** We use an in-memory Node.js `Map` to track IP requests. While this doesn't synchronize across multiple Node processes, it is perfectly sufficient for a single-node deployment.

3. **Direct Asynchronous Processing:**
   - **Previous:** A Transactional Outbox pattern fed into BullMQ to ensure jobs (like S3 garbage collection and chunk verification) were reliably executed by separate worker processes.
   - **Lite Mode:** The Transactional Outbox logic is replaced with direct, non-blocking asynchronous function calls executed within the main Node.js process immediately after a database transaction commits.

4. **Retained Components:**
   - **Rust Delta Engine:** The high-performance FastCDC and hashing logic (NAPI-RS + Rayon) remains completely intact.
   - **S3 Pre-signed Uploads:** The two-phase chunk upload process directly to S3 remains the core data transfer mechanism.
   - **FlatBuffer Manifests:** Zero-copy binary chunk manifests are still utilized for high-speed local processing.

## Lite Mode Diagram

```mermaid
graph TD
    Client[CLI / Client] -->|1. Hash & Negotiate| NodeAPI[Node.js API Server]
    NodeAPI -->|Rust NAPI| RustCore[Rust FastCDC & Hashing]
    NodeAPI <-->|Embedded DB| SQLite[(SQLite Database)]
    Client -->|2. Direct Upload via Pre-signed URL| S3[(S3 Compatible Storage)]
    NodeAPI -->|3. Commit & Async Verification| S3
    
    subgraph Background Processing [Direct Async Calls (No BullMQ/Redis)]
        NodeAPI -.->|Trigger| GC[Garbage Collector]
        NodeAPI -.->|Trigger| Verify[Chunk Verifier]
    end
```
