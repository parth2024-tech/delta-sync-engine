/**
 * Distributed Negotiation Store — database-backed implementation.
 *
 * Persists negotiation sessions directly to PostgreSQL/SQLite, ensuring
 * that horizontal multi-node replicas and load balancers do not experience
 * session loss or 410 Expired errors between negotiation and commit.
 */

export * from "./negotiation-store-db";
