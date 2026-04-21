import { useMemo } from "react";
import { useOutletContext } from "react-router-dom";
import { useMetrics, type MetricPoint } from "../../api";
import { Sparkline } from "../../components/Sparkline";

type Ctx = { dna: string };

type MetricField = "integration_rate" | "lag_p50_ms" | "lag_p99_ms" | "pending_backlog";

export function DnaMetrics() {
  const { dna } = useOutletContext<Ctx>();
  const { data } = useMetrics({ dna, hours: 48 });
  const byObserver = useMemo(() => {
    const m: Record<string, MetricPoint[]> = {};
    for (const p of data?.metrics ?? []) {
      (m[p.observer_id] ||= []).push(p);
    }
    return m;
  }, [data]);

  const keys = Object.keys(byObserver).sort();

  return (
    <div className="space-y-4">
      <h2 className="text-sm text-muted uppercase tracking-wider">
        Per-observer · last 48h · hourly
      </h2>
      {keys.length === 0 && (
        <p className="text-muted text-sm">No hourly metrics yet.</p>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {keys.map((observer) => {
          const rows = byObserver[observer];
          return (
            <div
              key={observer}
              className="bg-surface border border-border rounded p-4"
            >
              <div className="text-xs text-muted mono mb-3">{observer}</div>
              <MetricRow label="Integration rate" rows={rows} field="integration_rate" />
              <MetricRow label="Lag p50 (ms)" rows={rows} field="lag_p50_ms" />
              <MetricRow label="Lag p99 (ms)" rows={rows} field="lag_p99_ms" />
              <MetricRow label="Pending backlog" rows={rows} field="pending_backlog" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MetricRow({
  label,
  rows,
  field,
}: {
  label: string;
  rows: MetricPoint[];
  field: MetricField;
}) {
  const data = [...rows]
    .sort((a, b) => a.bucket_hour_iso.localeCompare(b.bucket_hour_iso))
    .map((r) => ({
      bucket_hour_iso: r.bucket_hour_iso,
      value: Number(r[field] ?? 0),
    }));
  const last = data[data.length - 1]?.value ?? 0;
  return (
    <div className="flex items-center gap-3 mb-2">
      <div className="w-36 text-xs text-muted">{label}</div>
      <div className="flex-1 min-w-0">
        <Sparkline data={data} />
      </div>
      <div className="w-16 text-right mono text-sm">
        {Number(last).toFixed(2)}
      </div>
    </div>
  );
}
