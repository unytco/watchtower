import useSWR from "swr";

// Empty in prod (worker and dashboard share the same origin, watchtower.unyt.dev).
// Set VITE_API_BASE for local dev when the worker is not reachable via the vite
// dev-server proxy, e.g. pointing to http://127.0.0.1:8787.
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export const fetcher = async <T>(url: string): Promise<T> => {
  const resp = await fetch(`${BASE}${url}`);
  if (!resp.ok) throw new Error(`${resp.status} ${await resp.text()}`);
  return (await resp.json()) as T;
};

export interface Observer {
  observer_id: string;
  last_seen_iso: string;
  last_collection_ms: number;
  uptime_s: number;
  schema_version: number;
  n_errors: number;
  is_healthy: number;
  binary_version: string;
}

export interface DnaListRow {
  dna_b64: string;
  dna_tag: string | null;
  observer_count: number;
  agent_count: number;
  total_actions: number;
  warrant_count: number;
  first_seen_iso: string | null;
  last_activity_iso: string | null;
}

export interface DnaSummary {
  dna_b64: string;
  dna_tag: string | null;
  agents: number;
  total_actions: number;
  // Migration counters: agents whose chain has closed (old network) / that
  // have opened onto this DNA (new network). Zero outside a migration window.
  // Optional so a dashboard built against a not-yet-migrated worker is
  // type-honest (the worker `AgentSummary` flags are likewise optional, and
  // DnaDetail guards with `?? 0`).
  agents_closed?: number;
  agents_opened?: number;
  warrants: number;
  observers: number;
  last_activity_iso: string | null;
}

export interface DnaAgent {
  agent_b64: string;
  agent_tag: string | null;
  action_count: number;
  observer_count: number;
  first_seen_iso: string;
  last_seen_iso: string;
  warrants_issued: number;
  warrants_against: number;
  // Migration flags, stored as 0/1 by D1. MAX across observers in canonical
  // mode; the raw row's value in per_observer mode.
  chain_closed: number;
  opening_summary_present: number;
  // Populated only in per_observer mode.
  observer_id?: string;
  dna_b64?: string;
}

export interface DnaObserver {
  observer_id: string;
  is_healthy: number | null;
  n_errors: number | null;
  observer_last_seen: string | null;
  binary_version: string | null;
  dna_first_seen: string;
  dna_last_seen: string;
  agents_seen: number;
  actions_reported: number;
}

export interface Warrant {
  observer_id: string;
  dna_b64: string;
  op_hash_b64: string;
  warrant_type: string;
  author_b64: string;
  target_b64: string;
  ts_iso: string;
  authored_ts_iso: string | null;
  integrated_ts_iso: string | null;
  validation_status: string | null;
  signature_b64: string | null;
  /// Worker stores the structured proof summary as JSON text. Parsed on
  /// render so unknown variants don't blow up `JSON.parse` upstream.
  proof_summary_json: string | null;
}

export type WarrantProofSummary =
  | {
      kind: "InvalidChainOp";
      action_author_b64: string;
      action_hash_b64: string;
      chain_op_type: string;
      // Holochain 0.7's human-readable rejection reason. Optional: pre-0.7
      // proof rows (and a 0.6→0.7 window) omit it (B110).
      reason?: string;
    }
  | {
      kind: "ChainFork";
      chain_author_b64: string;
      action_a_hash_b64: string;
      action_b_hash_b64: string;
      // Chain position the fork occurred at. Optional for the same reason.
      seq?: number;
    }
  | { kind: "Other"; description: string };

export function parseProofSummary(raw: string | null): WarrantProofSummary | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && typeof obj.kind === "string") {
      return obj as WarrantProofSummary;
    }
    return null;
  } catch {
    return null;
  }
}

export interface MetricPoint {
  observer_id: string;
  dna_b64: string;
  bucket_hour_iso: string;
  // null when the observer's read degraded that cycle (B107): rendered as "—",
  // and drawn as a gap in the sparkline, rather than a misleading 0.
  integration_rate: number | null;
  lag_p50_ms: number | null;
  lag_p99_ms: number | null;
  pending_backlog: number | null;
}

export function useObservers() {
  return useSWR<{ observers: Observer[] }>("/api/observers", fetcher, {
    refreshInterval: 30_000,
  });
}

export function useDnaList() {
  return useSWR<{ dnas: DnaListRow[] }>("/api/dnas", fetcher, {
    refreshInterval: 30_000,
  });
}

export function useDnaSummary(dna: string | undefined) {
  return useSWR<DnaSummary>(dna ? `/api/dnas/${encodeURIComponent(dna)}/summary` : null, fetcher, {
    refreshInterval: 30_000,
  });
}

export function useDnaAgents(
  dna: string | undefined,
  opts: { perObserver?: boolean; limit?: number } = {},
) {
  const params = new URLSearchParams();
  if (opts.perObserver) params.set("per_observer", "1");
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString() ? `?${params}` : "";
  return useSWR<{ agents: DnaAgent[]; per_observer: boolean }>(
    dna ? `/api/dnas/${encodeURIComponent(dna)}/agents${qs}` : null,
    fetcher,
  );
}

export function useDnaObservers(dna: string | undefined) {
  return useSWR<{ observers: DnaObserver[] }>(
    dna ? `/api/dnas/${encodeURIComponent(dna)}/observers` : null,
    fetcher,
    { refreshInterval: 30_000 },
  );
}

export function useWarrants(opts: { observerId?: string; dna?: string; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (opts.observerId) params.set("observer_id", opts.observerId);
  if (opts.dna) params.set("dna", opts.dna);
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString() ? `?${params}` : "";
  return useSWR<{ warrants: Warrant[] }>(`/api/warrants${qs}`, fetcher);
}

export function useMetrics(opts: { observerId?: string; dna?: string; hours?: number } = {}) {
  const params = new URLSearchParams({ hours: String(opts.hours ?? 24) });
  if (opts.observerId) params.set("observer_id", opts.observerId);
  if (opts.dna) params.set("dna", opts.dna);
  return useSWR<{ metrics: MetricPoint[] }>(`/api/metrics?${params}`, fetcher);
}

export function useDiff(since: string, opts: { observerId?: string; dna?: string } = {}) {
  const params = new URLSearchParams({ since });
  if (opts.observerId) params.set("observer_id", opts.observerId);
  if (opts.dna) params.set("dna", opts.dna);
  return useSWR<{
    since: string;
    observer_id?: string;
    dna_b64?: string;
    changed: Record<string, number>;
  }>(`/api/diff?${params}`, fetcher);
}

// ---------------------------------------------------------------------------
// Bridge-service reporter (/api/dnas/:dna/bridge)
// ---------------------------------------------------------------------------

export interface BridgeService {
  observer_id: string;
  dna_b64: string;
  last_seen_iso: string;
  uptime_s: number;
  binary_version: string;
  last_cycle_at_iso: string | null;
  last_cycle_ms: number | null;
  consecutive_failed_cycles: number;
  reconnect_failures_total: number;
  reconnects_ok_total: number;
  pressure_active: number;
  pressure_consecutive: number;
  // The unclassified-failure streak, twin of the pressure pair above.
  // Optional so a dashboard built against a not-yet-migrated worker is
  // type-honest; `computeStatus` treats absent as "no streak", the same
  // reading as the column's 0 default.
  unclassified_active?: number;
  unclassified_consecutive?: number;
  stage_ejections_total: number;
  is_stuck: number;
  last_error: string | null;
  last_error_at_iso: string | null;
  updated_at: string;
}

export interface BridgeBacklogRow {
  observer_id: string;
  dna_b64: string;
  collected_at: string;
  detected: number;
  queued: number;
  claimed: number;
  in_flight: number;
  succeeded_total: number;
  failed_total: number;
  oldest_queued_age_s: number | null;
  updated_at: string;
}

export interface BridgeThroughputRow {
  observer_id: string;
  dna_b64: string;
  bucket_hour_iso: string;
  succeeded: number;
  failed: number;
  avg_time_to_succeed_s: number | null;
}

export function useBridgeService(dna: string | undefined) {
  return useSWR<{
    services: BridgeService[];
    backlog: BridgeBacklogRow[];
    throughput: BridgeThroughputRow[];
  }>(dna ? `/api/dnas/${encodeURIComponent(dna)}/bridge` : null, fetcher, {
    refreshInterval: 30_000,
  });
}

export function useSearch(q: string) {
  return useSWR<{
    results: Array<{
      kind: string;
      hash: string;
      dna_b64: string;
      observer_id: string;
      tag: string | null;
    }>;
  }>(q ? `/api/search?q=${encodeURIComponent(q)}` : null, fetcher);
}
