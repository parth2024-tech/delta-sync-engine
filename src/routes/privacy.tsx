import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteHeader } from "@/components/site-header";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy | Deltasync" },
      {
        name: "description",
        content: "Technical privacy policy and data governance practices for Deltasync.",
      },
    ],
  }),
  component: PrivacyPage,
});

export function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-6 py-12">
        <div className="mb-8">
          <p className="font-mono text-xs uppercase tracking-widest text-primary">
            // compliance & governance
          </p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Privacy Policy</h1>
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            Effective Date: November 23, 2026 | Last Updated: November 2026
          </p>
        </div>

        <article className="space-y-8 text-sm leading-relaxed text-muted-foreground">
          <section className="rounded-lg border border-border bg-card/30 p-6">
            <h2 className="font-mono text-base font-semibold text-foreground">
              1. Local-First Cryptographic Hashing
            </h2>
            <p className="mt-2">
              Deltasync operates on an asynchronous content-addressed storage (CAS) architecture.
              Weak rolling hashes (Adler-32) and cryptographic verification digests (SHA-256) are
              computed locally on your machine before any network socket transmission occurs.
              Unchanged blocks never leave your local environment.
            </p>
          </section>

          <section className="rounded-lg border border-border bg-card/30 p-6">
            <h2 className="font-mono text-base font-semibold text-foreground">
              2. Data Collected & Stored
            </h2>
            <p className="mt-2">
              When using the synchronization service, the engine stores strictly the technical
              artifacts required to reconstruct files and maintain sync journals:
            </p>
            <ul className="mt-3 list-disc space-y-2 pl-5 font-mono text-xs">
              <li>
                <strong className="text-foreground">Authentication:</strong> Scoped API key hashes,
                session tokens, and user IDs.
              </li>
              <li>
                <strong className="text-foreground">Manifests:</strong> File paths, byte offsets,
                block sizes, and SHA-256 content hashes.
              </li>
              <li>
                <strong className="text-foreground">CAS Blocks:</strong> Chunk payloads compressed
                via zlib / zstd, referenced strictly by cryptographic digest.
              </li>
              <li>
                <strong className="text-foreground">Job Telemetry:</strong> Transfer duration, bytes
                transferred, bytes saved, and completion status.
              </li>
            </ul>
          </section>

          <section className="rounded-lg border border-border bg-card/30 p-6">
            <h2 className="font-mono text-base font-semibold text-foreground">
              3. Telemetry & Tracking
            </h2>
            <p className="mt-2">
              Deltasync does not deploy advertising cookies, canvas fingerprinting, or commercial
              third-party tracking scripts. Distributed tracing utilizes standard W3C Trace Context
              headers (traceparent) solely for debugging network bottlenecks, chunk upload timeouts,
              and storage latency.
            </p>
          </section>

          <section className="rounded-lg border border-border bg-card/30 p-6">
            <h2 className="font-mono text-base font-semibold text-foreground">
              4. Data Retention & Deletion
            </h2>
            <p className="mt-2">
              You retain total ownership of all uploaded data. Revoking an API key instantly halts
              active synchronization sessions. When a file version or project is deleted,
              unreferenced CAS blocks are automatically marked for garbage collection and swept by
              reference-counted lifecycle workers.
            </p>
          </section>

          <section className="rounded-lg border border-border bg-card/30 p-6">
            <h2 className="font-mono text-base font-semibold text-foreground">
              5. Security Governance
            </h2>
            <p className="mt-2">
              All communications between CLI agents, web clients, and backend API routes require TLS
              1.3 encryption in transit. Binary payloads and CAS objects are stored isolated behind
              authenticated tenant barriers.
            </p>
          </section>
        </article>

        <div className="mt-12 border-t border-border pt-6 flex justify-between text-xs font-mono text-muted-foreground">
          <Link to="/" className="text-primary hover:underline">
            ← Return to Overview
          </Link>
          <Link to="/terms" className="text-primary hover:underline">
            Terms of Service →
          </Link>
        </div>
      </main>
    </div>
  );
}
