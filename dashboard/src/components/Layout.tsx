import { Link, NavLink, Outlet } from "react-router-dom";
import { ObserverSwitcher } from "./ObserverSwitcher";
import { SearchBar } from "./SearchBar";

const tabs: Array<{ to: string; label: string }> = [
  { to: "/", label: "Overview" },
  { to: "/dnas", label: "DNAs" },
  { to: "/agents", label: "Agents" },
  { to: "/warrants", label: "Warrants" },
  { to: "/metrics", label: "Metrics" },
  { to: "/alerts", label: "Alerts" },
  { to: "/diff", label: "Diff" },
];

export function Layout() {
  return (
    <div className="min-h-full flex flex-col">
      <header className="border-b border-border bg-surface">
        <div className="max-w-[1280px] mx-auto flex items-center gap-6 px-6 py-3">
          <Link to="/" className="font-semibold tracking-tight">
            unyt · watchtower
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            {tabs.map((t) => (
              <NavLink
                key={t.to}
                to={t.to}
                className={({ isActive }) =>
                  `px-2 py-1 rounded ${isActive ? "text-fg" : "text-muted hover:text-fg"}`
                }
                end={t.to === "/"}
              >
                {t.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <SearchBar />
            <ObserverSwitcher />
          </div>
        </div>
      </header>
      <main className="flex-1 max-w-[1280px] w-full mx-auto px-6 py-6">
        <Outlet />
      </main>
      <footer className="border-t border-border text-xs text-muted text-center py-3">
        Tier-1 summaries only. Bulk exports via <span className="mono">hc-watchtower export-*</span> on the observer host.
      </footer>
    </div>
  );
}
