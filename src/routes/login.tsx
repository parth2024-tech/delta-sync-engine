import { createFileRoute, redirect, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { signIn, signUp } from "@/lib/auth.functions";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Sign In — Deltasync" },
      { name: "description", content: "Sign in to your Deltasync account." },
    ],
  }),
  beforeLoad: async () => {
    const { getSession } = await import("@/lib/auth.functions");
    const session = await getSession();
    if (session) throw redirect({ to: "/dashboard" });
  },
  component: LoginPage,
});

function LoginPage() {
  const [mode, setMode]       = useState<"signin" | "signup">("signin");
  const [email, setEmail]     = useState("");
  const [password, setPass]   = useState("");
  const [name, setName]       = useState("");
  const [error, setError]     = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (mode === "signup") {
        await signUp({ data: { email, password, displayName: name } });
      } else {
        await signIn({ data: { email, password } });
      }
      navigate({ to: "/dashboard" });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Link to="/" className="inline-flex items-center gap-2 font-mono text-sm font-semibold">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-sm bg-primary text-primary-foreground text-base">δ</span>
            <span>deltasync</span>
          </Link>
          <h1 className="mt-6 text-2xl font-bold">{mode === "signin" ? "Welcome back" : "Create account"}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === "signin" ? "Sign in to your dashboard." : "Start syncing files in minutes."}
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card/40 p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === "signup" && (
              <div>
                <label className="block font-mono text-xs uppercase tracking-widest text-muted-foreground mb-1">Display name</label>
                <input
                  type="text" required value={name} onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  placeholder="Ada Lovelace"
                />
              </div>
            )}
            <div>
              <label className="block font-mono text-xs uppercase tracking-widest text-muted-foreground mb-1">Email</label>
              <input
                type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                placeholder="you@example.com"
              />
            </div>
            <div>
              <label className="block font-mono text-xs uppercase tracking-widest text-muted-foreground mb-1">Password</label>
              <input
                type="password" required value={password} onChange={(e) => setPass(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                placeholder={mode === "signup" ? "At least 8 characters" : "••••••••"}
              />
            </div>
            {error && <p className="text-sm text-red-400 font-mono">{error}</p>}
            <button
              type="submit" disabled={loading}
              className="w-full rounded-md bg-primary px-4 py-2 font-mono text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
            >
              {loading ? "…" : mode === "signin" ? "Sign in" : "Create account"}
            </button>
          </form>

          <div className="mt-4 text-center text-sm text-muted-foreground">
            {mode === "signin" ? (
              <>Don't have an account?{" "}
                <button onClick={() => setMode("signup")} className="text-primary hover:underline font-mono">Sign up</button>
              </>
            ) : (
              <>Already have an account?{" "}
                <button onClick={() => setMode("signin")} className="text-primary hover:underline font-mono">Sign in</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
