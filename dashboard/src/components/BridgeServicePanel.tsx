import {
  useBridgeService,
  type BridgeService,
  type BridgeBacklogRow,
  type BridgeThroughputRow,
} from "../api";
import { Sparkline } from "./Sparkline";
import { relTime } from "../lib/format";

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
        <StatusBadge status={status} />
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <Tile label="queued" value={backlog?.queued} />
        <Tile label="in flight" value={backlog?.in_flight} />
        <Tile label="failed (24h)" value={sumBucket(throughput, "failed")} />
        <Tile
          label="succeeded (24h)"
          value={sumBucket(throughput, "succeeded")}
        />
      </div>

      {succeededSpark.length > 0 && (
        <div className="mb-3">
          <div className="text-xs text-muted mb-1">succeeded / hour</div>
          <Sparkline data={succeededSpark} height={40} />
        </div>
      )}

      <footer className="text-xs text-muted flex flex-wrap gap-x-3 gap-y-1">
        <span>
          last cycle{" "}
          {service.last_cycle_at_iso
            ? relTime(service.last_cycle_at_iso)
            : "never"}
          {service.last_cycle_ms != null
            ? ` · ${(service.last_cycle_ms / 1000).toFixed(1)}s`
            : ""}
        </span>
        {service.consecutive_failed_cycles > 0 && (
          <span className="text-amber-400">
            {service.consecutive_failed_cycles} failed in a row
          </span>
        )}
        {service.reconnect_failures_total > 0 && (
          <span>{service.reconnect_failures_total} reconnect failures</span>
        )}
        {backlog?.oldest_queued_age_s != null && (
          <span>oldest queued {formatUptime(backlog.oldest_queued_age_s)}</span>
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

type Status = "healthy" | "pressure" | "failing" | "stuck";

function computeStatus(s: BridgeService): Status {
  if (s.is_stuck) return "stuck";
  if (s.pressure_active) return "pressure";
  if (s.consecutive_failed_cycles >= 2) return "failing";
  return "healthy";
}

function StatusBadge({ status }: { status: Status }) {
  const styles: Record<Status, string> = {
    healthy: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
    pressure: "bg-amber-500/10 text-amber-400 border-amber-500/30",
    failing: "bg-amber-500/10 text-amber-400 border-amber-500/30",
    stuck: "bg-red-500/10 text-red-400 border-red-500/30",
  };
  const labels: Record<Status, string> = {
    healthy: "healthy",
    pressure: "pressure cooldown",
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

function Tile({ label, value }: { label: string; value?: number | null }) {
  return (
    <div className="bg-bg border border-border rounded p-2">
      <div className="text-xs text-muted">{label}</div>
      <div className="mono text-lg">
        {value == null ? "—" : value.toLocaleString()}
      </div>
    </div>
  );
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
