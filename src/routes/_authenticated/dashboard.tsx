import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getDashboardStats } from "@/lib/sync.functions";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard | Deltasync" }] }),
  component: Dashboard,
});

function fmt(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-5">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 font-mono text-2xl font-bold text-foreground">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Dashboard() {
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["dashboard-stats"],
    queryFn: () => getDashboardStats(),
    refetchInterval: 10000,
  });

  if (isLoading)
    return (
      <PageShell>
        <div className="flex items-center justify-center h-64">
          <span className="font-mono text-sm text-muted-foreground animate-pulse">loading…</span>
        </div>
      </PageShell>
    );
  if (error)
    return (
      <PageShell>
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-6 font-mono text-sm">
          <p className="text-red-400 font-semibold">Failed to load telemetry stats.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Make sure you are signed in and the database is accessible.
          </p>
          <button
            onClick={() => refetch()}
            className="mt-4 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-secondary"
          >
            Retry Connection
          </button>
        </div>
      </PageShell>
    );

  const series = (data?.dailySeries ?? []).map((d) => ({
    day: d.day?.slice(0, 10) ?? "",
    transferred: Number(d.transferred),
    saved: Number(d.saved),
  }));

  const isEmpty = (data?.totalFiles ?? 0) === 0;

  return (
    <PageShell onRefresh={() => refetch()} isFetching={isFetching}>
      {/* KPIs */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Files synced" value={String(data?.totalFiles ?? 0)} />
        <KpiCard label="Lifetime saved" value={fmt(data?.totalBytesSaved ?? 0)} />
        <KpiCard
          label="Transfer ratio"
          value={`${data?.transferRatio ?? 0}%`}
          sub="bytes saved vs total"
        />
        <KpiCard label="Active (24 h)" value={String(data?.activeIn24h ?? 0)} sub="sync jobs" />
      </div>

      {/* Chart */}
      <div className="mt-6 rounded-lg border border-border bg-card/40 p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            30-day bandwidth
          </h2>
          <div className="flex items-center gap-4 text-xs font-mono">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-cyan-400" />
              transferred
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-amber-400" />
              saved
            </span>
          </div>
        </div>
        {series.length === 0 ? (
          <div className="h-48 flex items-center justify-center text-sm text-muted-foreground font-mono">
            no data yet
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={series} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey="day"
                tick={{ fontSize: 10, fontFamily: "monospace" }}
                tickFormatter={(v) => v.slice(5)}
              />
              <YAxis
                tick={{ fontSize: 10, fontFamily: "monospace" }}
                tickFormatter={(v) => fmt(v)}
                width={60}
              />
              <Tooltip
                formatter={(v: number) => fmt(v)}
                labelStyle={{ fontFamily: "monospace", fontSize: 11 }}
              />
              <Area
                type="monotone"
                dataKey="transferred"
                stroke="#22d3ee"
                fill="#22d3ee22"
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="saved"
                stroke="#fbbf24"
                fill="#fbbf2422"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Recent jobs */}
      <div className="mt-6 rounded-lg border border-border bg-card/40">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Recent jobs
          </h2>
          <Link to="/jobs" className="font-mono text-xs text-primary hover:underline">
            View all jobs →
          </Link>
        </div>
        {isEmpty ? (
          <div className="p-10 text-center">
            <p className="font-mono text-sm text-muted-foreground mb-4">
              No syncs yet. Create an API key and install the CLI to get started.
            </p>
            <Link
              to="/keys"
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 font-mono text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              Create API key →
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {["File", "Direction", "Transferred", "Saved", "Status", "Date"].map((h) => (
                    <th
                      key={h}
                      className="px-4 py-3 text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(data?.recentJobs ?? []).map((j) => (
                  <tr key={j.id} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="px-4 py-3 font-mono text-xs text-primary">
                      <Link to="/jobs" className="hover:underline">
                        {j.filePath || "untitled"}
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{j.direction}</td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {fmt(Number(j.bytesTransferred))}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-amber-400">
                      {fmt(Number(j.bytesSaved))}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`font-mono text-[10px] rounded px-1.5 py-0.5 ${
                          j.status === "done"
                            ? "bg-emerald-500/20 text-emerald-400"
                            : j.status === "error"
                              ? "bg-red-500/20 text-red-400"
                              : "bg-cyan-500/20 text-cyan-400"
                        }`}
                      >
                        {j.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {new Date(j.startedAt!).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </PageShell>
  );
}

function PageShell({
  children,
  onRefresh,
  isFetching,
}: {
  children: React.ReactNode;
  onRefresh?: () => void;
  isFetching?: boolean;
}) {
  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <p className="mb-1 font-mono text-xs uppercase tracking-widest text-primary">
            // monitoring
          </p>
          <h1 className="text-3xl font-bold">Dashboard</h1>
        </div>
        {onRefresh && (
          <button
            onClick={onRefresh}
            className="flex items-center gap-2 rounded-md border border-border bg-card/40 px-3 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                isFetching ? "bg-amber-400 animate-ping" : "bg-emerald-400"
              }`}
            />
            {isFetching ? "Syncing..." : "Refresh"}
          </button>
        )}
      </div>
      {children}
    </div>
  );
}
