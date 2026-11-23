import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { listApiKeys, createApiKey, revokeApiKey } from "@/lib/api-keys.functions";

export const Route = createFileRoute("/_authenticated/keys")({
  head: () => ({ meta: [{ title: "API Keys | Deltasync" }] }),
  component: KeysPage,
});

function KeysPage() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["api-keys"],
    queryFn: () => listApiKeys(),
  });

  const createMut = useMutation({
    mutationFn: (l: string) => createApiKey({ data: { label: l } }),
    onSuccess: (res) => {
      setNewKey(res.key);
      setLabel("");
      setCreating(false);
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) => revokeApiKey({ data: { id } }),
    onSuccess: () => {
      setRevoking(null);
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="mb-1 font-mono text-xs uppercase tracking-widest text-primary">
            // authentication
          </p>
          <h1 className="text-3xl font-bold">API Keys</h1>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => refetch()}
            className="flex items-center gap-2 rounded-md border border-border bg-card/40 px-3 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                isFetching ? "bg-amber-400 animate-ping" : "bg-emerald-400"
              }`}
            />
            {isFetching ? "Syncing..." : "Refresh"}
          </button>
          <button
            onClick={() => setCreating(true)}
            className="rounded-md bg-primary px-4 py-2 font-mono text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            + New key
          </button>
        </div>
      </div>

      {/* New key revealed */}
      {newKey && (
        <div className="mb-6 rounded-lg border border-amber-400/40 bg-amber-400/10 p-5">
          <p className="font-mono text-xs text-amber-400 font-semibold mb-2 flex items-center gap-1.5">
            <span>●</span>
            Save this key now. For security reasons, it will never be displayed again.
          </p>
          <div className="flex items-center gap-3">
            <code className="flex-1 rounded bg-background px-3 py-2 font-mono text-sm break-all border border-border">
              {newKey}
            </code>
            <button
              onClick={() => copy(newKey)}
              className="shrink-0 rounded border border-border px-3 py-2 font-mono text-xs hover:bg-secondary"
            >
              {copied ? "✓ Copied" : "Copy Key"}
            </button>
          </div>
          <button
            onClick={() => setNewKey(null)}
            className="mt-3 font-mono text-xs text-muted-foreground hover:text-foreground"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Create modal */}
      {creating && (
        <div className="mb-6 rounded-lg border border-border bg-card/40 p-5">
          <h3 className="font-mono text-sm font-semibold mb-3">Create API Key</h3>
          <div className="flex items-center gap-3">
            <input
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label (e.g. workstation-laptop)"
              className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              onKeyDown={(e) => e.key === "Enter" && label && createMut.mutate(label)}
            />
            <button
              disabled={!label || createMut.isPending}
              onClick={() => createMut.mutate(label)}
              className="rounded-md bg-primary px-4 py-2 font-mono text-sm font-semibold text-primary-foreground disabled:opacity-60"
            >
              {createMut.isPending ? "Generating…" : "Create"}
            </button>
            <button
              onClick={() => setCreating(false)}
              className="font-mono text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
          {createMut.isError && (
            <p className="mt-2 text-sm text-red-400 font-mono">
              {(createMut.error as Error).message}
            </p>
          )}
        </div>
      )}

      {/* Keys table */}
      <div className="rounded-lg border border-border bg-card/40">
        {isLoading ? (
          <div className="flex items-center justify-center h-32">
            <span className="font-mono text-sm text-muted-foreground animate-pulse">loading…</span>
          </div>
        ) : (data ?? []).length === 0 ? (
          <div className="p-10 text-center">
            <p className="font-mono text-sm text-muted-foreground">
              No keys yet. Create one to authenticate CLI and daemon sync agents.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {["Prefix", "Label", "Last used", "Created", "Actions"].map((h) => (
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
                {(data ?? []).map((k) => (
                  <tr
                    key={k.id}
                    className={`border-b border-border/50 ${
                      k.revokedAt ? "opacity-40" : "hover:bg-secondary/20"
                    }`}
                  >
                    <td className="px-4 py-3 font-mono text-xs text-primary">{k.prefix}…</td>
                    <td className="px-4 py-3 font-mono text-xs">{k.label}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : "never"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {new Date(k.createdAt!).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {k.revokedAt ? (
                        <span className="font-mono text-[10px] rounded px-1.5 py-0.5 bg-red-500/20 text-red-400">
                          revoked
                        </span>
                      ) : revoking === k.id ? (
                        <span className="font-mono text-xs">
                          Revoke key?{" "}
                          <button
                            onClick={() => revokeMut.mutate(k.id)}
                            className="text-red-400 hover:underline font-semibold"
                          >
                            Yes
                          </button>
                          {" / "}
                          <button onClick={() => setRevoking(null)} className="hover:underline">
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setRevoking(k.id)}
                          className="font-mono text-xs text-red-400/80 hover:text-red-400 hover:underline"
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* CLI install hint */}
      <div className="mt-8 rounded-lg border border-border bg-card/20 p-5">
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground mb-3">
          CLI Quickstart
        </p>
        <pre className="text-xs font-mono bg-background rounded p-3 overflow-x-auto text-primary/80 whitespace-pre-wrap">{`# 1. Install CLI locally
cd cli && npm install && npm run build && npm link

# 2. Authenticate CLI session (paste key when prompted)
deltasync init

# 3. Push file or directory with delta-sync
deltasync push ./my-large-file.bin

# 4. Pull differential reconstruct
deltasync pull ./my-large-file.bin`}</pre>
      </div>
    </div>
  );
}
