import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteHeader } from "@/components/site-header";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms of Service | Deltasync" },
      {
        name: "description",
        content: "Terms of service and acceptable usage guidelines for Deltasync.",
      },
    ],
  }),
  component: TermsPage,
});

export function TermsPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-6 py-12">
        <div className="mb-8">
          <p className="font-mono text-xs uppercase tracking-widest text-primary">
            // agreement & terms
          </p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Terms of Service</h1>
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            Effective Date: November 23, 2026 | Revision: 2026.2
          </p>
        </div>

        <article className="space-y-8 text-sm leading-relaxed text-muted-foreground">
          <section className="rounded-lg border border-border bg-card/30 p-6">
            <h2 className="font-mono text-base font-semibold text-foreground">
              1. Platform Services & SLA
            </h2>
            <p className="mt-2">
              Deltasync provides distributed, delta-based chunk synchronization engines, CLI
              tooling, and web observability dashboards. Service availability targets high
              durability across content-addressed block storage and transactional manifest backends.
              Maintenance windows are scheduled with zero downtime where rolling updates permit.
            </p>
          </section>

          <section className="rounded-lg border border-border bg-card/30 p-6">
            <h2 className="font-mono text-base font-semibold text-foreground">
              2. Acceptable Use Policy
            </h2>
            <p className="mt-2">
              You agree to utilize the platform strictly for lawful software and data
              synchronization. Prohibited behaviors include:
            </p>
            <ul className="mt-3 list-disc space-y-2 pl-5 font-mono text-xs">
              <li>
                Deploying automated flood requests designed to disrupt negotiation handshakes or
                saturate chunk endpoints.
              </li>
              <li>
                Transmitting malicious binaries, exploit payloads, or unauthorized copyrighted
                material.
              </li>
              <li>
                Reverse-engineering or attempting to bypass tenant token validation, signature
                checks, or cryptographic boundaries.
              </li>
            </ul>
          </section>

          <section className="rounded-lg border border-border bg-card/30 p-6">
            <h2 className="font-mono text-base font-semibold text-foreground">
              3. Quotas & Rate Limits
            </h2>
            <p className="mt-2">
              To guarantee cluster stability across all clients, API endpoints and WebSocket
              channels are governed by adaptive token-bucket rate limiters. Chunk uploads and
              downloads must respect server backpressure signals and concurrency bounds.
            </p>
          </section>

          <section className="rounded-lg border border-border bg-card/30 p-6">
            <h2 className="font-mono text-base font-semibold text-foreground">
              4. Data Portability & Termination
            </h2>
            <p className="mt-2">
              You may export, download, or completely erase stored files and manifests at any time
              using the authenticated dashboard or CLI commands. Upon account termination, all
              active sessions, API key records, and unreferenced storage blocks are permanently
              purged.
            </p>
          </section>

          <section className="rounded-lg border border-border bg-card/30 p-6">
            <h2 className="font-mono text-base font-semibold text-foreground">
              5. Limitation of Liability
            </h2>
            <p className="mt-2">
              The service is provided on an "as is" and "as available" basis. While cryptographic
              digests (SHA-256) verify byte-level transfer integrity, users remain responsible for
              maintaining independent disaster-recovery backups for mission-critical datasets.
            </p>
          </section>
        </article>

        <div className="mt-12 border-t border-border pt-6 flex justify-between text-xs font-mono text-muted-foreground">
          <Link to="/" className="text-primary hover:underline">
            ← Return to Overview
          </Link>
          <Link to="/privacy" className="text-primary hover:underline">
            Privacy Policy →
          </Link>
        </div>
      </main>
    </div>
  );
}
