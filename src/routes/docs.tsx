import { createFileRoute } from "@tanstack/react-router";
import { SiteHeader } from "@/components/site-header";

export const Route = createFileRoute("/docs")({
  head: () => ({
    meta: [
      { title: "Docs — Deltasync" },
      { name: "description", content: "Protocol documentation and CLI usage for the deltasync engine." },
    ],
  }),
  component: Docs,
});

function Docs() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <div className="mx-auto max-w-3xl px-6 py-10">
        <p className="mb-2 font-mono text-xs uppercase tracking-widest text-primary">
          // documentation
        </p>
        <h1 className="mb-8 font-display text-3xl font-bold">Protocol & algorithm</h1>

        <article className="prose prose-invert max-w-none space-y-6 text-sm leading-relaxed text-muted-foreground">
          <section>
            <h2 className="font-display text-xl font-semibold text-foreground">1. Block signatures</h2>
            <p>
              The server splits the existing file into fixed-size blocks (default
              1 KiB). For each block it stores:
            </p>
            <ul className="ml-6 list-disc space-y-1">
              <li><code className="text-primary">offset</code>, <code className="text-primary">length</code></li>
              <li><code className="text-primary">weak</code> — Adler-32 (32-bit)</li>
              <li><code className="text-primary">strong</code> — SHA-256 (hex)</li>
            </ul>
          </section>

          <section>
            <h2 className="font-display text-xl font-semibold text-foreground">2. Rolling Adler-32</h2>
            <p>
              Adler-32 of window <code className="text-primary">[i, i+W)</code> can be updated in O(1) when the window
              slides one byte:
            </p>
            <pre className="overflow-x-auto rounded-md border border-border bg-background p-4 text-xs text-foreground">
{`A' = (A − bytes[i] + bytes[i+W])     mod 65521
B' = (B − W·bytes[i] + A' − 1)       mod 65521
hash = (B' << 16) | A'`}
            </pre>
          </section>

          <section>
            <h2 className="font-display text-xl font-semibold text-foreground">3. Two-level lookup</h2>
            <p>
              A 16-bit hash table maps <code className="text-primary">weak16</code> → candidate block list. On a weak hit,
              the window is verified with SHA-256 — collision-proof. On a confirmed
              match the algorithm emits a <code className="text-reuse">COPY</code> op
              and jumps the window forward by <code className="text-primary">blockSize</code>.
              Otherwise the leftmost byte joins a <code className="text-literal">LITERAL</code> run
              and the window slides by 1.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl font-semibold text-foreground">4. Wire format</h2>
            <p>The delta is a sequence of opcodes:</p>
            <pre className="overflow-x-auto rounded-md border border-border bg-background p-4 text-xs text-foreground">
{`COPY    blockIndex:u32  length:u32      // ~8 bytes
LITERAL length:u32       bytes:u8[len]   // length + payload`}
            </pre>
            <p>
              Only literals consume payload bandwidth. A 4 GB file with a 1% edit
              transfers ~40 MB.
            </p>
          </section>

          <section>
            <h2 className="font-display text-xl font-semibold text-foreground">5. Local cache (client)</h2>
            <p>
              The reference CLI keeps a SQLite database at
              <code className="text-primary"> .deltasync/cache.db</code> with tables for files, versions,
              and block hashes — so unchanged files between runs skip re-hashing
              entirely.
            </p>
          </section>
        </article>
      </div>
    </div>
  );
}
