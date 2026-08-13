import { useOutletContext, Link } from "react-router-dom";
import { useDnaAgents, useMetrics, useWarrants } from "../../api";
import { Sparkline } from "../../components/Sparkline";
import { CopyableHash } from "../../components/CopyableHash";
import { HelpTip } from "../../components/HelpTip";
import { BridgeServicePanel } from "../../components/BridgeServicePanel";
import { labelForAgent, relTime } from "../../lib/format";
import {
  formatMetric,
  metricHelp,
  metricLabels,
  type MetricField,
} from "../../lib/metricHelp";

type Ctx = { dna: string };

export function DnaOverview() {
  const { dna } = useOutletContext<Ctx>();
  const { data: metrics } = useMetrics({ dna, hours: 24 });
  const { data: warrants } = useWarrants({ dna, limit: 5 });
  const { data: agentsData } = useDnaAgents(dna, { limit: 5 });

  const metricRows = (metrics?.metrics ?? []).slice().sort((a, b) =>
    a.bucket_hour_iso.localeCompare(b.bucket_hour_iso),
  );
  const lastBucket = metricRows[metricRows.length - 1]?.bucket_hour_iso;

  return (
    <div className="space-y-6">
      <section>
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-sm text-muted uppercase tracking-wider">
            Last 24h
          </h2>
          {lastBucket && (
            <div className="text-xs text-muted">
              last bucket {relTime(lastBucket)}
            </div>
          )}
        </div>
        <div className="bg-surface border border-border rounded p-4 space-y-2">
          <SparkRow rows={metricRows} field="integration_rate" />
          <SparkRow rows={metricRows} field="lag_p50_ms" />
          <SparkRow rows={metricRows} field="lag_p99_ms" />
          <SparkRow rows={metricRows} field="pending_backlog" />
          {metricRows.length === 0 && (
            <div className="text-xs text-muted">
              No hourly metrics yet — they roll up from the 5-minute cron.
            </div>
          )}
        </div>
      </section>

      <BridgeServicePanel dna={dna} />

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
                <span className="text-xs truncate min-w-0">
                  <CopyableHash
                    value={a.agent_b64}
                    label={labelForAgent(a.agent_tag, a.agent_b64)}
                  />
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
                <span className="text-xs truncate min-w-0 flex items-center gap-1">
                  <span className="mono">{w.warrant_type}</span>
                  <span aria-hidden className="text-muted">·</span>
                  <CopyableHash value={w.author_b64} />
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
  rows,
  field,
}: {
  rows: Array<{ bucket_hour_iso: string } & Record<MetricField, number | null>>;
  field: MetricField;
}) {
  const data = rows.map((r) => ({
    bucket_hour_iso: r.bucket_hour_iso,
    // Keep a degraded bucket as null so the sparkline gaps rather than dipping
    // to a fake 0 (B107).
    value: r[field],
  }));
  // A null latest bucket is "unknown": NaN makes formatMetric render "—".
  const lastRaw = data[data.length - 1]?.value;
  const last = lastRaw == null ? NaN : Number(lastRaw);
  return (
    <div className="flex items-center gap-3">
      <div className="w-36 text-xs text-muted flex items-center gap-1.5">
        <span>{metricLabels[field]}</span>
        <HelpTip label={`What is ${metricLabels[field]}?`}>
          {metricHelp[field]}
        </HelpTip>
      </div>
      <div className="flex-1 min-w-0">
        <Sparkline data={data} field={field} height={40} />
      </div>
      <div className="w-24 text-right mono text-sm">
        {formatMetric(field, last)}
      </div>
    </div>
  );
}
