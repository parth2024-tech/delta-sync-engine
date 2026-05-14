import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteHeader } from "@/components/site-header";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — Deltasync" },
      { name: "description", content: "Monitor sync jobs, file versions, and bandwidth savings across your projects." },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <div className="mx-auto max-w-7xl px-6 py-10">
        <p className="mb-2 font-mono text-xs uppercase tracking-widest text-primary">
          // monitoring
        </p>
        <h1 className="mb-2 font-display text-3xl font-bold">Dashboard</h1>
        <p className="mb-8 max-w-2xl text-muted-foreground">
          The full dashboard ships in the next release with auth, file versions,
          job history, and API key management. Until then, try the live algorithm
          in the playground.
        </p>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { l: "files synced", v: "—" },
            { l: "bytes transferred", v: "—" },
            { l: "bytes saved", v: "—" },
            { l: "transfer ratio", v: "—" },
          ].map((s) => (
            <div key={s.l} className="rounded-lg border border-border bg-card/40 p-5">
              <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                {s.l}
              </div>
              <div className="mt-2 font-display text-2xl font-bold text-muted-foreground/40">{s.v}</div>
            </div>
          ))}
        </div>

        <div className="mt-8 rounded-lg border border-dashed border-border bg-card/20 p-10 text-center">
          <p className="font-mono text-sm text-muted-foreground">
            Sign in & API key management coming next.
          </p>
          <Link
            to="/playground"
            className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 font-mono text-sm font-semibold text-primary-foreground"
          >
            ▸ try the playground
          </Link>
        </div>
      </div>
    </div>
  );
}
