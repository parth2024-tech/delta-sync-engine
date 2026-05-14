import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteHeader } from "@/components/site-header";
import { RollingHashAnimation } from "@/components/rolling-hash-animation";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />

      {/* Hero */}
      <section className="relative overflow-hidden border-b border-border">
        <div className="absolute inset-0 bg-grid opacity-40" />
        <div className="absolute inset-0 bg-radial-fade" />
        <div className="relative mx-auto max-w-7xl px-6 py-24 lg:py-32">
          <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
            <div>
              <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 font-mono text-xs text-primary">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                rsync algorithm · adler-32 + sha-256
              </div>
              <h1 className="font-display text-5xl font-bold leading-[1.05] tracking-tight lg:text-6xl">
                Send only the<br />
                <span className="text-primary">bytes that changed.</span>
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
                Deltasync is a delta-based file synchronization engine. It uses a
                rolling Adler-32 hash to detect shifted content in O(1) per byte,
                then verifies matches with SHA-256 — so a 4&nbsp;GB file with a
                1% edit transfers in 40&nbsp;MB, not 4&nbsp;GB.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link
                  to="/playground"
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 font-mono text-sm font-semibold text-primary-foreground shadow-glow transition-transform hover:-translate-y-0.5"
                >
                  ▸ run the live demo
                </Link>
                <Link
                  to="/docs"
                  className="inline-flex items-center gap-2 rounded-md border border-border bg-secondary/50 px-5 py-2.5 font-mono text-sm font-semibold text-foreground transition-colors hover:bg-secondary"
                >
                  read the protocol
                </Link>
              </div>
              <dl className="mt-10 grid grid-cols-3 gap-6 border-t border-border pt-6 font-mono text-sm">
                <div>
                  <dt className="text-xs uppercase tracking-widest text-muted-foreground">block size</dt>
                  <dd className="mt-1 text-xl text-foreground">1 KiB</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-widest text-muted-foreground">weak hash</dt>
                  <dd className="mt-1 text-xl text-foreground">adler-32</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-widest text-muted-foreground">verify</dt>
                  <dd className="mt-1 text-xl text-foreground">sha-256</dd>
                </div>
              </dl>
            </div>

            <div className="flex flex-col gap-4">
              <RollingHashAnimation />
              <div className="rounded-lg border border-border bg-card/40 p-5 font-mono text-xs">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-muted-foreground">$ deltasync push report.pdf</span>
                  <span className="text-reuse">● success</span>
                </div>
                <pre className="whitespace-pre-wrap leading-relaxed text-muted-foreground">
{`scanning 4,194,304 bytes ........ 4096 blocks
fetching remote signatures ...... 4096 sigs
computing delta ................. 41 changed
`}
<span className="text-foreground">transferred       42,128 bytes</span>{`
`}<span className="text-primary">saved          4,152,176 bytes  (98.99%)</span>
                </pre>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="border-b border-border">
        <div className="mx-auto max-w-7xl px-6 py-20">
          <p className="mb-2 font-mono text-xs uppercase tracking-widest text-primary">
            // how the algorithm works
          </p>
          <h2 className="mb-12 max-w-2xl font-display text-3xl font-bold lg:text-4xl">
            Four steps from file diff to network savings.
          </h2>
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <div
                key={s.title}
                className="group relative rounded-lg border border-border bg-card/40 p-6 transition-colors hover:border-primary/50"
              >
                <div className="mb-4 font-mono text-xs text-primary">
                  step {String(i + 1).padStart(2, "0")}
                </div>
                <h3 className="mb-2 font-display text-lg font-semibold">{s.title}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Architecture */}
      <section>
        <div className="mx-auto max-w-7xl px-6 py-20">
          <p className="mb-2 font-mono text-xs uppercase tracking-widest text-primary">
            // system architecture
          </p>
          <h2 className="mb-12 max-w-2xl font-display text-3xl font-bold lg:text-4xl">
            Client and server share one algorithm.
          </h2>
          <div className="overflow-x-auto rounded-lg border border-border bg-card/40 p-8">
            <pre className="font-mono text-[13px] leading-relaxed text-muted-foreground">
{` ┌────────────────┐         delta protocol          ┌────────────────┐
 │  `}<span className="text-foreground">Client (CLI)</span>{`  │  ──────── HTTPS / WS ────────▶  │  `}<span className="text-foreground">Sync Server</span>{`   │
 │  + SQLite      │                                 │  + Object Store│
 │  + `}<span className="text-primary">Rolling Hash</span>{`│  ◀──── block signatures ─────   │  + Postgres    │
 └────────────────┘                                 └────────────────┘
         │                                                    │
         └─────────── `}<span className="text-primary">Web Dashboard</span>{` ─────────────────────┘
                  monitors jobs, files, versions, savings`}
            </pre>
          </div>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-7xl px-6 py-8 font-mono text-xs text-muted-foreground">
          deltasync · distributed systems · © 2026
        </div>
      </footer>
    </div>
  );
}

const STEPS = [
  {
    title: "Block & sign",
    body:
      "Server splits the existing file into fixed-size blocks. For each block it computes a weak Adler-32 hash and a strong SHA-256 hash.",
  },
  {
    title: "Roll the window",
    body:
      "Client slides a window of blockSize bytes across the new file. Adler-32 updates in O(1) when one byte enters and another leaves.",
  },
  {
    title: "Two-level match",
    body:
      "On a 16-bit weak hit, verify with SHA-256. A confirmed match emits a COPY op; otherwise the leftmost byte joins a literal run.",
  },
  {
    title: "Stream the delta",
    body:
      "Only literal runs travel over the wire. The server replays COPY + LITERAL ops against its existing blocks to reconstruct the new file.",
  },
];
