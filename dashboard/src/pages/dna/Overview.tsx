import { useOutletContext, Link } from "react-router-dom";
import { useDnaAgents, useMetrics, useWarrants } from "../../api";
import { Sparkline } from "../../components/Sparkline";
import { labelForAgent, relTime, truncHash } from "../../lib/format";

type Ctx = { dna: string };

type MetricField = "integration_rate" | "lag_p50_ms" | "lag_p99_ms" | "pending_backlog";

export function DnaOverview() {
  const { dna } = useOutletContext<Ctx>();
  const { data: metrics } = useMetrics({ dna, hours: 24 });
  const { data: warrants } = useWarrants({ dna, limit: 5 });
  const { data: agentsData } = useDnaAgents(dna, { limit: 5 });

  const metricRows = (metrics?.metrics ?? []).slice().sort((a, b) =>
    a.bucket_hour_iso.localeCompare(b.bucket_hour_iso),
  );

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-sm text-muted uppercase tracking-wider mb-2">
          Last 24h
        </h2>
        <div className="bg-surface border border-border rounded p-4 space-y-2">
          <SparkRow label="Integration rate" rows={metricRows} field="integration_rate" />
          <SparkRow label="Lag p50 (ms)" rows={metricRows} field="lag_p50_ms" />
          <SparkRow label="Lag p99 (ms)" rows={metricRows} field="lag_p99_ms" />
          <SparkRow label="Pending backlog" rows={metricRows} field="pending_backlog" />
          {metricRows.length === 0 && (
            <div className="text-xs text-muted">
              No hourly metrics yet — they roll up from the 5-minute cron.
            </div>
          )}
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-surface border border-border rounded p-4">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="text-sm font-semibold">Top agents</h3>
            <Link
              to="agents"
              className="text-xs text-muted hover:text-fg"
            >
              all agents →
            </Link>
          </div>
          <ul className="space-y-1 text-sm">
            {(agentsData?.agents ?? []).map((a) => (
              <li
                key={a.agent_b64}
                className="flex items-center justify-between gap-2"
              >
                <span className="mono text-xs truncate">
                  {labelForAgent(a.agent_tag, a.agent_b64)}
                </span>
                <span className="mono text-xs">
                  {a.action_count.toLocaleString()}
                </span>
              </li>
            ))}
            {(agentsData?.agents ?? []).length === 0 && (
              <li className="text-xs text-muted">No agents discovered yet.</li>
            )}
          </ul>
        </div>

        <div className="bg-surface border border-border rounded p-4">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="text-sm font-semibold">Recent warrants</h3>
            <Link
              to="warrants"
              className="text-xs text-muted hover:text-fg"
            >
              all warrants →
            </Link>
          </div>
          <ul className="space-y-1 text-sm">
            {(warrants?.warrants ?? []).map((w) => (
              <li
                key={`${w.observer_id}-${w.op_hash_b64}`}
                className="flex items-center justify-between gap-2"
              >
                <span className="mono text-xs truncate">
                  {w.warrant_type} · {truncHash(w.author_b64)}
                </span>
                <span className="text-xs text-muted">{relTime(w.ts_iso)}</span>
              </li>
            ))}
            {(warrants?.warrants ?? []).length === 0 && (
              <li className="text-xs text-muted">No warrants reported.</li>
            )}
          </ul>
        </div>
      </section>
    </div>
  );
}

function SparkRow({
  label,
  rows,
  field,
}: {
  label: string;
  rows: Array<{ bucket_hour_iso: string } & Record<MetricField, number>>;
  field: MetricField;
}) {
  const data = rows.map((r) => ({
    bucket_hour_iso: r.bucket_hour_iso,
    value: Number(r[field] ?? 0),
  }));
  const last = data[data.length - 1]?.value ?? 0;
  return (
    <div className="flex items-center gap-3">
      <div className="w-36 text-xs text-muted">{label}</div>
      <div className="flex-1 min-w-0">
        <Sparkline data={data} height={40} />
      </div>
      <div className="w-16 text-right mono text-sm">
        {Number(last).toFixed(2)}
      </div>
    </div>
  );
}
