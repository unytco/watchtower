import type { ReactNode } from "react";

// Help content for the bridge-service panel metrics. Mirrors the shape of
// `metricHelp.tsx` so the UI can reuse the same `HelpTip` affordance. Keep
// copy short and orient each explainer to what the number *means* for the
// operator, not how it's computed line-by-line.

export type BridgeField =
  | "avg_time_to_succeed_24h"
  | "queued"
  | "in_flight"
  | "failed_24h"
  | "succeeded_spark"
  | "avg_time_spark"
  | "status_badge"
  | "last_cycle"
  | "consecutive_failed_cycles"
  | "reconnect_failures_total"
  | "oldest_queued_age_s";

export const bridgeHelp: Record<BridgeField, ReactNode> = {
  avg_time_to_succeed_24h: (
    <div className="space-y-1.5">
      <div>
        Rolling 24-hour average of how long a single bridge work item takes from <em>created</em> to{" "}
        <em>succeeded</em>.
      </div>
      <div className="text-muted">
        Computed on the orchestrator as <span className="mono">AVG(updated_at − created_at)</span>{" "}
        over succeeded items in the last 24h. Low and flat is healthy; growing numbers mean the
        bridge is taking longer per item.
      </div>
    </div>
  ),
  queued: (
    <div className="space-y-1.5">
      <div>
        Work items in the <span className="mono">queued</span> state on the orchestrator right now —
        detected but not yet claimed for processing.
      </div>
      <div className="text-muted">
        A persistently non-zero queue with near-zero <span className="mono">in flight</span> usually
        means the bridge cycle is stalled.
      </div>
    </div>
  ),
  in_flight: (
    <div className="space-y-1.5">
      <div>
        Work items currently being processed — claimed by the orchestrator and mid-flight through
        one of the bridge stages.
      </div>
      <div className="text-muted">
        Should be a small number that churns over. Stuck here means the stage is blocked (chain
        call, Holochain RPC, etc.).
      </div>
    </div>
  ),
  failed_24h: (
    <div className="space-y-1.5">
      <div>
        Total items that reached the <span className="mono">failed</span> terminal state in the last
        24 hours.
      </div>
      <div className="text-muted">
        Aggregated from the hourly buckets in <span className="mono">bridge_throughput_ts</span>.
        Occasional failures are normal; a growing rate warrants checking{" "}
        <span className="mono">last error</span>.
      </div>
    </div>
  ),
  succeeded_spark: (
    <div>
      Count of items that succeeded in the preceding 60 minutes, sampled once per hour. Each point
      is the rolling-1h total at the last report of that hour.
    </div>
  ),
  avg_time_spark: (
    <div>
      Rolling 24h average of time-to-succeed, sampled once per hour. Shows how the moving average
      drifts over time.
    </div>
  ),
  status_badge: (
    <div className="space-y-1">
      <div>
        <span className="mono">healthy</span> — reporting and bridge cycle running cleanly.
      </div>
      <div>
        <span className="mono">pressure cooldown</span> — orchestrator is intentionally throttling
        after repeated pressure signals.
      </div>
      <div>
        <span className="mono">unclassified cooldown</span> — cycles are failing with an error the
        orchestrator recognises as none of its known classes. Throttled the same way as pressure,
        but the cause is unknown — check <span className="mono">last error</span>.
      </div>
      <div>
        <span className="mono">failing cycles</span> — 2 or more bridge cycles in a row have failed.
      </div>
      <div>
        <span className="mono">stuck</span> — the orchestrator has flagged itself as unable to make
        progress.
      </div>
    </div>
  ),
  last_cycle: (
    <div className="space-y-1.5">
      <div>
        When the last full bridge cycle completed, and how long it took (
        <span className="mono">Ns</span>).
      </div>
      <div className="text-muted">
        "never" means no cycle has completed since startup. Durations spiking usually track queue
        pressure or slow downstream RPC.
      </div>
    </div>
  ),
  consecutive_failed_cycles: (
    <div>
      Number of bridge cycles that have failed in a row since the last success. Resets to zero on
      the next successful cycle.
    </div>
  ),
  reconnect_failures_total: (
    <div>
      Lifetime counter of failed attempts to reconnect to Holochain admin/app sockets. Increasing
      means connectivity is flapping; the bridge auto-recovers.
    </div>
  ),
  oldest_queued_age_s: (
    <div>
      Age of the oldest item still sitting in <span className="mono">queued</span>. A growing value
      with non-zero <span className="mono">queued</span> is an early signal of a stall.
    </div>
  ),
};
