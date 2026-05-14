import { createFileRoute, redirect, Outlet, Link, useNavigate } from "@tanstack/react-router";
import { getSession, signOut } from "@/lib/auth.functions";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async () => {
    const session = await getSession();
    if (!session) throw redirect({ to: "/login" });
    return { user: session };
  },
  component: AuthLayout,
});

function AuthLayout() {
  const { user } = Route.useRouteContext();
  const navigate  = useNavigate();

  async function handleSignOut() {
    await signOut();
    navigate({ to: "/" });
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
          <div className="flex items-center gap-6">
            <Link to="/" className="flex items-center gap-2 font-mono text-sm font-semibold">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-sm bg-primary text-primary-foreground">δ</span>
              <span>deltasync</span>
            </Link>
            <nav className="flex items-center gap-1 text-sm">
              {[
                { to: "/dashboard", label: "Dashboard" },
                { to: "/files",     label: "Files"     },
                { to: "/jobs",      label: "Jobs"      },
                { to: "/keys",      label: "API Keys"  },
              ].map(({ to, label }) => (
                <Link
                  key={to} to={to}
                  className="rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  activeProps={{ className: "rounded-md px-3 py-1.5 bg-secondary text-foreground" }}
                >
                  {label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs text-muted-foreground hidden sm:block">{user.email}</span>
            <button
              onClick={handleSignOut}
              className="rounded-md border border-border px-3 py-1.5 font-mono text-xs text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <Outlet />
    </div>
  );
}
