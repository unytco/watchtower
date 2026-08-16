import { Link } from "react-router-dom";
import { useDnaList, useObservers } from "../api";
import { labelForDna, relTime } from "../lib/format";
import { CopyableHash } from "../components/CopyableHash";

export function DnaList() {
  const { data: dnaData, error: dnaError, isLoading } = useDnaList();
  const dnas = dnaData?.dnas ?? [];
  return (
    <div className="space-y-6">
      <FleetStrip />

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h1 className="text-lg font-semibold">DNAs</h1>
          {dnas.length > 0 && <div className="text-xs text-muted">{dnas.length} tracked</div>}
        </div>

        {dnaError && (
          <div className="border border-border rounded p-4 text-sm text-danger">
            Failed to load DNAs: {String(dnaError)}
          </div>
        )}

        {!dnaError && dnas.length === 0 && !isLoading && (
          <div className="border border-border rounded p-6 text-center text-sm text-muted">
            No DNAs reported yet. Start <span className="mono">hc-watchtower-observer</span> on a
            node.
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {dnas.map((d) => {
            const tag = labelForDna(d.dna_tag, d.dna_b64);
            return (
              <Link
                key={d.dna_b64}
                to={`/dnas/${encodeURIComponent(d.dna_b64)}`}
                className="bg-surface border border-border rounded p-4 hover:border-accent transition-colors block"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="font-semibold">{tag}</div>
                  <div className="text-xs text-muted">{relTime(d.last_activity_iso)}</div>
                </div>
                {d.dna_tag && (
                  <div className="text-xs text-muted mt-0.5">
                    <CopyableHash value={d.dna_b64} head={10} tail={6} />
                  </div>
                )}
                <div className="grid grid-cols-4 gap-3 mt-4">
                  <MiniStat label="Actions" value={d.total_actions} />
                  <MiniStat label="Agents" value={d.agent_count} />
                  <MiniStat
                    label="Warrants"
                    value={d.warrant_count}
                    tone={d.warrant_count > 0 ? "danger" : undefined}
                  />
                  <MiniStat label="Observers" value={d.observer_count} />
                </div>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: number; tone?: "danger" }) {
  return (
    <div>
      <div className="text-[10px] text-muted uppercase tracking-wider">{label}</div>
      <div className={`text-lg font-semibold mono ${tone === "danger" ? "text-danger" : ""}`}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function FleetStrip() {
  const { data, error } = useObservers();
  const observers = data?.observers ?? [];
  if (error) return null;
  if (observers.length === 0) return null;
  return (
    <section>
      <div className="text-[10px] text-muted uppercase tracking-wider mb-2">Fleet</div>
      <div className="flex flex-wrap gap-2">
        {observers.map((o) => (
          <div
            key={o.observer_id}
            className="bg-surface border border-border rounded px-3 py-1.5 text-xs flex items-center gap-2"
            title={`last seen ${o.last_seen_iso} · ${o.n_errors} errors · ${o.binary_version}`}
          >
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                o.is_healthy ? "bg-ok" : "bg-danger"
              }`}
            />
            <span className="mono">{o.observer_id}</span>
            <span className="text-muted">{relTime(o.last_seen_iso)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
