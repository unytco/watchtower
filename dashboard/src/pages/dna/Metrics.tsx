import { useMemo } from "react";
import { useOutletContext } from "react-router-dom";
import { useMetrics, type MetricPoint } from "../../api";
import { Sparkline } from "../../components/Sparkline";
import { CopyableHash } from "../../components/CopyableHash";
import { HelpTip } from "../../components/HelpTip";
import { formatBucketLocal } from "../../lib/format";
import { formatMetric, metricHelp, metricLabels, type MetricField } from "../../lib/metricHelp";

type Ctx = { dna: string };

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
      {keys.length === 0 && <p className="text-muted text-sm">No hourly metrics yet.</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {keys.map((observer) => {
          const rows = byObserver[observer];
          const lastBucket = rows
            .map((r) => r.bucket_hour_iso)
            .sort()
            .pop();
          return (
            <div key={observer} className="bg-surface border border-border rounded p-4">
              <div className="flex items-baseline justify-between mb-3 text-xs">
                <CopyableHash value={observer} />
                {lastBucket && <span className="text-muted">{formatBucketLocal(lastBucket)}</span>}
              </div>
              <MetricRow rows={rows} field="integration_rate" />
              <MetricRow rows={rows} field="lag_p50_ms" />
              <MetricRow rows={rows} field="lag_p99_ms" />
              <MetricRow rows={rows} field="pending_backlog" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MetricRow({ rows, field }: { rows: MetricPoint[]; field: MetricField }) {
  const data = [...rows]
    .sort((a, b) => a.bucket_hour_iso.localeCompare(b.bucket_hour_iso))
    .map((r) => ({
      bucket_hour_iso: r.bucket_hour_iso,
      // Keep a degraded bucket as null so the sparkline gaps rather than dipping
      // to a fake 0 (B107).
      value: r[field],
    }));
  // A null latest bucket is "unknown": NaN makes formatMetric render "—",
  // distinct from a real 0 which reads as "0 ops/s" / "0 ms".
  const lastRaw = data[data.length - 1]?.value;
  const last = lastRaw == null ? NaN : Number(lastRaw);
  return (
    <div className="flex items-center gap-3 mb-2">
      <div className="w-36 text-xs text-muted flex items-center gap-1.5">
        <span>{metricLabels[field]}</span>
        <HelpTip label={`What is ${metricLabels[field]}?`}>{metricHelp[field]}</HelpTip>
      </div>
      <div className="flex-1 min-w-0">
        <Sparkline data={data} field={field} />
      </div>
      <div className="w-24 text-right mono text-sm">{formatMetric(field, last)}</div>
    </div>
  );
}
