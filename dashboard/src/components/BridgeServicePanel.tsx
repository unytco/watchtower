import {
  useBridgeService,
  type BridgeService,
  type BridgeBacklogRow,
  type BridgeThroughputRow,
} from "../api";
import { Sparkline } from "./Sparkline";
import { HelpTip } from "./HelpTip";
import { relTime } from "../lib/format";
import { bridgeHelp, type BridgeField } from "../lib/bridgeHelp";

/**
 * DNA-scoped bridge-service health panel. Renders nothing when no
 * bridge reporter has posted for this DNA, so other DNAs are visually
 * unchanged.
 */
export function BridgeServicePanel({ dna }: { dna: string }) {
  const { data } = useBridgeService(dna);
  const services = data?.services ?? [];
  if (services.length === 0) return null;

  const backlogByObs = new Map(
    (data?.backlog ?? []).map((b) => [b.observer_id, b]),
  );

  return (
    <section>
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm text-muted uppercase tracking-wider">
          Bridge service
        </h2>
        <div className="text-xs text-muted">
          {services.length === 1
            ? "1 reporter"
            : `${services.length} reporters`}
        </div>
      </div>
      <div className="space-y-4">
        {services.map((s) => (
          <ServiceRow
            key={s.observer_id}
            service={s}
            backlog={backlogByObs.get(s.observer_id)}
            throughput={(data?.throughput ?? []).filter(
              (t) => t.observer_id === s.observer_id,
            )}
          />
        ))}
      </div>
    </section>
  );
}

function ServiceRow({
  service,
  backlog,
  throughput,
}: {
  service: BridgeService;
  backlog?: BridgeBacklogRow;
  throughput: BridgeThroughputRow[];
}) {
  const status = computeStatus(service);
  const succeededSpark = throughput
    .slice()
    .sort((a, b) => a.bucket_hour_iso.localeCompare(b.bucket_hour_iso))
    .map((r) => ({
      bucket_hour_iso: r.bucket_hour_iso,
      value: r.succeeded,
    }));

  const latestBucket = throughput
    .slice()
    .sort((a, b) => b.bucket_hour_iso.localeCompare(a.bucket_hour_iso))[0];
  const avgTimeS = latestBucket?.avg_time_to_succeed_s ?? null;

  const avgTimeSpark = throughput
    .slice()
    .sort((a, b) => a.bucket_hour_iso.localeCompare(b.bucket_hour_iso))
    .filter((r) => r.avg_time_to_succeed_s != null)
    .map((r) => ({
      bucket_hour_iso: r.bucket_hour_iso,
      value: r.avg_time_to_succeed_s as number,
    }));

  return (
    <div className="bg-surface border border-border rounded p-4">
      <header className="flex items-baseline justify-between mb-3 gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">
            {service.observer_id}
          </div>
          <div className="text-xs text-muted">
            version {service.binary_version} · uptime {formatUptime(service.uptime_s)}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <StatusBadge status={status} />
          <HelpTip label="Bridge service status legend">
            {bridgeHelp.status_badge}
          </HelpTip>
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <Tile
          label="avg time to succeed (24h)"
          value={formatSecsHuman(avgTimeS)}
          help="avg_time_to_succeed_24h"
        />
        <Tile label="queued" value={backlog?.queued} help="queued" />
        <Tile label="in flight" value={backlog?.in_flight} help="in_flight" />
        <Tile
          label="failed (24h)"
          value={sumBucket(throughput, "failed")}
          help="failed_24h"
        />
      </div>

      {succeededSpark.length > 0 && (
        <div className="mb-3">
          <div className="text-xs text-muted mb-1 flex items-center gap-1.5">
            <span>succeeded (rolling 1h) · hourly samples</span>
            <HelpTip label="What is succeeded (rolling 1h)?">
              {bridgeHelp.succeeded_spark}
            </HelpTip>
          </div>
          <Sparkline data={succeededSpark} height={40} />
        </div>
      )}

      {avgTimeSpark.length > 1 && (
        <div className="mb-3">
          <div className="text-xs text-muted mb-1 flex items-center gap-1.5">
            <span>avg time to succeed (rolling 24h) · hourly samples</span>
            <HelpTip label="What is avg time to succeed (rolling 24h)?">
              {bridgeHelp.avg_time_spark}
            </HelpTip>
          </div>
          <Sparkline data={avgTimeSpark} height={40} />
        </div>
      )}

      <footer className="text-xs text-muted flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5">
          <span>
            last cycle{" "}
            {service.last_cycle_at_iso
              ? relTime(service.last_cycle_at_iso)
              : "never"}
            {service.last_cycle_ms != null
              ? ` · ${(service.last_cycle_ms / 1000).toFixed(1)}s`
              : ""}
          </span>
          <HelpTip label="What is last cycle?">
            {bridgeHelp.last_cycle}
          </HelpTip>
        </span>
        {service.consecutive_failed_cycles > 0 && (
          <span className="inline-flex items-center gap-1.5 text-amber-400">
            <span>{service.consecutive_failed_cycles} failed in a row</span>
            <HelpTip label="What is failed in a row?">
              {bridgeHelp.consecutive_failed_cycles}
            </HelpTip>
          </span>
        )}
        {service.reconnect_failures_total > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span>{service.reconnect_failures_total} reconnect failures</span>
            <HelpTip label="What is reconnect failures?">
              {bridgeHelp.reconnect_failures_total}
            </HelpTip>
          </span>
        )}
        {backlog?.oldest_queued_age_s != null && (
          <span className="inline-flex items-center gap-1.5">
            <span>
              oldest queued {formatUptime(backlog.oldest_queued_age_s)}
            </span>
            <HelpTip label="What is oldest queued?">
              {bridgeHelp.oldest_queued_age_s}
            </HelpTip>
          </span>
        )}
        {service.last_error && (
          <span className="text-red-400 truncate" title={service.last_error}>
            last error: {service.last_error}
          </span>
        )}
      </footer>
    </div>
  );
}

type Status = "healthy" | "pressure" | "unclassified" | "failing" | "stuck";

function computeStatus(s: BridgeService): Status {
  if (s.is_stuck) return "stuck";
  if (s.pressure_active) return "pressure";
  // The orchestrator sets at most one cooldown class per cycle, so the order
  // between these two only decides a tie that cannot occur in practice.
  if (s.unclassified_active) return "unclassified";
  if (s.consecutive_failed_cycles >= 2) return "failing";
  return "healthy";
}

function StatusBadge({ status }: { status: Status }) {
  const styles: Record<Status, string> = {
    healthy: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
    pressure: "bg-amber-500/10 text-amber-400 border-amber-500/30",
    unclassified: "bg-amber-500/10 text-amber-400 border-amber-500/30",
    failing: "bg-amber-500/10 text-amber-400 border-amber-500/30",
    stuck: "bg-red-500/10 text-red-400 border-red-500/30",
  };
  const labels: Record<Status, string> = {
    healthy: "healthy",
    pressure: "pressure cooldown",
    unclassified: "unclassified cooldown",
    failing: "failing cycles",
    stuck: "stuck",
  };
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded border uppercase tracking-wide ${styles[status]}`}
    >
      {labels[status]}
    </span>
  );
}

function Tile({
  label,
  value,
  help,
}: {
  label: string;
  value?: number | string | null;
  help?: BridgeField;
}) {
  return (
    <div className="bg-bg border border-border rounded p-2">
      <div className="text-xs text-muted flex items-center gap-1.5">
        <span>{label}</span>
        {help && (
          <HelpTip label={`What is ${label}?`}>{bridgeHelp[help]}</HelpTip>
        )}
      </div>
      <div className="mono text-lg">
        {value == null
          ? "—"
          : typeof value === "number"
            ? value.toLocaleString()
            : value}
      </div>
    </div>
  );
}

function formatSecsHuman(s: number | null | undefined): string | null {
  if (s == null) return null;
  if (s < 60) return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  if (s < 86_400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86_400).toFixed(1)}d`;
}

function sumBucket(
  rows: BridgeThroughputRow[],
  field: "succeeded" | "failed",
): number {
  return rows.reduce((acc, r) => acc + (r[field] ?? 0), 0);
}

function formatUptime(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}
