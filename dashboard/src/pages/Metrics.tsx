import { useMemo } from "react";
import { useMetrics, type MetricPoint } from "../api";
import { useAppContext } from "../context";
import { Sparkline } from "../components/Sparkline";
import { labelForDna } from "../lib/format";

type MetricField = "integration_rate" | "lag_p50_ms" | "lag_p99_ms" | "pending_backlog";

export function Metrics() {
  const { observerId } = useAppContext();
  const { data } = useMetrics(observerId ?? undefined, undefined, 48);
  const byDna = useMemo(() => {
    const m: Record<string, MetricPoint[]> = {};
    for (const p of data?.metrics ?? []) {
      const key = `${p.observer_id}|${p.dna_b64}`;
      (m[key] ||= []).push(p);
    }
    return m;
  }, [data]);

  const keys = Object.keys(byDna).sort();

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Metrics (last 48h, hourly)</h1>
      {keys.length === 0 && <p className="text-muted text-sm">No data yet.</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {keys.map((k) => {
          const rows = byDna[k];
          const [observer, dna] = k.split("|");
          return (
            <div key={k} className="bg-surface border border-border rounded p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm mono">{labelForDna(null, dna)}</div>
                <div className="text-xs text-muted mono">{observer}</div>
              </div>
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
      <div className="flex-1">
        <Sparkline data={data} />
      </div>
      <div className="w-16 text-right mono text-sm">{Number(last).toFixed(2)}</div>
    </div>
  );
}
