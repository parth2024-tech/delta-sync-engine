# Feature Boundary & MVP Scope

This document defines the feature boundaries for the Delta Sync Engine, divided into what is necessary for the Minimum Viable Product (MVP), what features are planned for post-MVP enhancements, and what is explicitly out of scope for the v1 release.

| MVP Must Have | Post-MVP Nice to Have | Out of Scope for v1 |
| :--- | :--- | :--- |
| **Core delta sync algorithm** (FastCDC + rolling hashes) | **Bidirectional sync** (conflict resolution, merging) | **Web UI** for end-users (desktop-first focus) |
| **Single direction sync** (Local File → S3) | **Message Queues** (BullMQ) for scaled workers | **Real-time syncing** (file watching daemon) |
| **CLI Tool** (`deltasync push`/`pull`) | **Redis** for distributed rate limiting & caching | **Mobile client applications** |
| **SQLite or File-based DB** for tracking state | **PostgreSQL** for multi-node centralized DB | **Multi-cloud storage abstractions** (GCP/Azure) |
| **Direct S3 Uploads** (Pre-signed URLs) | **Event-Driven Webhooks** | **End-to-End Encryption** (client-side keys) |
| **Direct function calls** for background tasks | **Advanced telemetry** and metrics collection | **Complex permission granularities** |
