import type { ReactNode } from "react";

// Source of truth for the four derived metrics: see
// watchtower/crates/hc_store/src/extensions.rs lines 171-242 and
// watchtower/crates/collector/src/tier1.rs lines 299-308.

export type MetricField =
  | "integration_rate"
  | "lag_p50_ms"
  | "lag_p99_ms"
  | "pending_backlog";

export const metricLabels: Record<MetricField, string> = {
  integration_rate: "Integration rate",
  lag_p50_ms: "Lag p50",
  lag_p99_ms: "Lag p99",
  pending_backlog: "Pending backlog",
};

export const metricHelp: Record<MetricField, ReactNode> = {
  integration_rate: (
    <div className="space-y-1.5">
      <div>
        Rate at which this observer's DHT is integrating ops, in{" "}
        <span className="mono">ops/second</span>.
      </div>
      <div className="text-muted">
        Measured as{" "}
        <span className="mono">integrated_ops / lag_window_s</span> over the most
        recent lag window (default 5 min). A flat zero with a non-zero backlog
        means integration is stalled.
      </div>
    </div>
  ),
  lag_p50_ms: (
    <div className="space-y-1.5">
      <div>
        Median time between an op being <em>authored</em> and this observer{" "}
        <em>integrating</em> it, in milliseconds.
      </div>
      <div className="text-muted">
        Computed from{" "}
        <span className="mono">ChainOp.when_integrated − Action.timestamp</span>{" "}
        over the lag window. Lower is better; healthy DHTs typically stay well
        under a second.
      </div>
    </div>
  ),
  lag_p99_ms: (
    <div className="space-y-1.5">
      <div>
        99th percentile of the same integration lag — the tail latency that the
        worst 1% of ops experience.
      </div>
      <div className="text-muted">
        Sustained spikes usually point at validation bottlenecks, slow peers,
        or ops that keep being re-fetched.
      </div>
    </div>
  ),
  pending_backlog: (
    <div className="space-y-1.5">
      <div>
        DHT ops this observer has received but hasn't integrated yet
        (<span className="mono">when_integrated IS NULL</span>).
      </div>
      <div className="text-muted">
        Trend matters more than the absolute number: a backlog that keeps
        growing means integration is falling behind; flat or declining is
        healthy.
      </div>
    </div>
  ),
};

export function formatMetric(field: MetricField, value: number): string {
  if (!Number.isFinite(value)) return "—";
  switch (field) {
    case "integration_rate":
      return `${value.toFixed(2)} ops/s`;
    case "lag_p50_ms":
    case "lag_p99_ms":
      return `${Math.round(value).toLocaleString()} ms`;
    case "pending_backlog":
      return `${Math.round(value).toLocaleString()} ops`;
  }
}
