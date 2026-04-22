import { NavLink, Outlet, useParams, Link } from "react-router-dom";
import { useDnaSummary } from "../api";
import { labelForDna, relTime } from "../lib/format";
import { CopyableHash } from "../components/CopyableHash";

const subTabs: Array<{ to: string; label: string; end?: boolean }> = [
  { to: ".", label: "Overview", end: true },
  { to: "agents", label: "Agents" },
  { to: "warrants", label: "Warrants" },
  { to: "observers", label: "Observers" },
  { to: "metrics", label: "Metrics" },
  { to: "diff", label: "Activity" },
];

export function DnaDetail() {
  const { dna = "" } = useParams();
  const dnaB64 = decodeURIComponent(dna);
  const { data: summary } = useDnaSummary(dnaB64);
  const title = labelForDna(summary?.dna_tag, dnaB64);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="text-xs text-muted flex items-center gap-1">
          <Link to="/" className="hover:text-fg">
            DNAs
          </Link>
          <span aria-hidden>·</span>
          <CopyableHash value={dnaB64} head={10} tail={6} />
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-xl font-semibold">{title}</h1>
          {summary?.last_activity_iso && (
            <div className="text-xs text-muted">
              last activity {relTime(summary.last_activity_iso)}
            </div>
          )}
        </div>
        {summary?.dna_tag && (
          <div className="text-xs text-muted">
            <CopyableHash value={dnaB64} head={64} tail={0} />
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2">
          <Tile label="Total actions" value={summary?.total_actions ?? 0} />
          <Tile label="Agents" value={summary?.agents ?? 0} />
          <Tile
            label="Warrants"
            value={summary?.warrants ?? 0}
            tone={summary && summary.warrants > 0 ? "danger" : undefined}
          />
          <Tile label="Observers" value={summary?.observers ?? 0} />
        </div>
      </header>

      <nav className="flex items-center gap-1 border-b border-border">
        {subTabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              `px-3 py-2 text-sm -mb-px border-b-2 ${
                isActive
                  ? "border-accent text-fg"
                  : "border-transparent text-muted hover:text-fg"
              }`
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>

      <Outlet context={{ dna: dnaB64 }} />
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "danger";
}) {
  return (
    <div className="bg-surface border border-border rounded p-4">
      <div className="text-xs text-muted uppercase tracking-wider">{label}</div>
      <div
        className={`text-3xl font-semibold mt-1 mono ${tone === "danger" ? "text-danger" : ""}`}
      >
        {value.toLocaleString()}
      </div>
    </div>
  );
}
