export interface Env {
  DB: D1Database;
  SCHEMA_VERSION: string;
  OBSERVER_TS_SKEW_SECS: string;
  ALLOWED_ORIGINS: string;
  RESEND_API_KEY?: string;
  ALERT_FROM_ADDRESS?: string;
}

export interface SelfHealth {
  uptime_s: number;
  last_collection_ms: number;
  n_errors_this_cycle: number;
  binary_version: string;
}

export interface IngestPayload {
  schema_version: number;
  observer_id: string;
  collected_at: string;
  self_health: SelfHealth;
  node: NodeSnapshot;
}

export interface NodeSnapshot {
  conductor: ConductorSnapshot;
  dnas: DnaSnapshot[];
  apps: AppSummary[];
  blocks: BlockSummary[];
}

export interface ConductorSnapshot {
  holochain_version?: string | null;
  admin_port?: number | null;
  running_apps: number;
  paused_apps: number;
  disabled_apps: number;
  nonce_count: number;
  nonce_duplicate_count: number;
}

export interface DnaSnapshot {
  dna_b64: string;
  dna_tag?: string | null;
  dna_definition?: {
    zomes: string[];
    properties_summary_json: string;
    network_seed?: string | null;
  } | null;
  agents: AgentSummary[];
  warrants: WarrantSummary[];
  chain_summaries: ChainSummary[];
  slice_hashes: SliceHashRow[];
  chain_locks: ChainLockRow[];
  scheduled_functions: ScheduledFunctionRow[];
  validation_coverage: ValidationCoverageRow[];
  cap_grants: CapGrantSummary[];
  derived_metrics: DerivedMetrics;
  pending_ops_count: number;
  integrated_ops_count: number;
}

export interface AgentSummary {
  agent_b64: string;
  agent_tag?: string | null;
  first_seen_iso: string;
  last_seen_iso: string;
  action_count: number;
  warrants_issued: number;
  warrants_against: number;
  // Migration visibility, derived by the observer from chain-terminating
  // actions already in the DHT. Optional so older observer payloads still
  // ingest; absent is treated as false.
  chain_closed?: boolean;
  opening_summary_present?: boolean;
}

export interface WarrantSummary {
  op_hash_b64: string;
  warrant_type: string;
  author_b64: string;
  target_b64: string;
  ts_iso: string;
  authored_ts_iso: string;
  integrated_ts_iso: string | null;
  validation_status: string | null;
  signature_b64: string;
  proof_summary: WarrantProofSummary;
}

export type WarrantProofSummary =
  | {
      kind: "InvalidChainOp";
      action_author_b64: string;
      action_hash_b64: string;
      chain_op_type: string;
      // Holochain 0.7's human-readable "why this op is invalid". Optional:
      // pre-0.7 proof rows (and a 0.6→0.7 window) omit it (B110).
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

export interface ChainSummary {
  agent_b64: string;
  action_count: number;
  first_ts_iso: string;
  last_ts_iso: string;
}

export interface SliceHashRow {
  arc_start: number;
  arc_end: number;
  slice_index: number;
  hash_b64: string;
}

export interface ChainLockRow {
  author_b64: string;
  subject_b64: string;
  expires_at_iso: string;
}

export interface ScheduledFunctionRow {
  author_b64: string;
  zome: string;
  fn_name: string;
  scheduled_at_iso: string;
}

export interface ValidationCoverageRow {
  op_hash_b64: string;
  receipt_count: number;
}

export interface CapGrantSummary {
  app_id: string;
  cell_b64: string;
  tag?: string | null;
  function_count: number;
  access_type: string;
}

// Each metric is null when the observer's read for it degraded that cycle
// (B107): the D1 timeseries stores NULL and the dashboard renders "—", distinct
// from a real zero. `pending_ops_count` / `integrated_ops_count` stay non-null
// (the observer posts their real count, collapsing to 0 only on a degraded read
// — B107 remainder, since their only reader is the CLI).
export interface DerivedMetrics {
  integration_rate: number | null;
  lag_p50_ms: number | null;
  lag_p99_ms: number | null;
  pending_backlog: number | null;
}

export interface AppSummary {
  app_id: string;
  happ_name: string;
  role_name: string;
  clone_of_app_id?: string | null;
}

export interface BlockSummary {
  target_id: string;
  reason: string;
  start_iso: string;
  end_iso: string;
}

// ---------------------------------------------------------------------------
// Bridge-service reporter (POST /ingest/bridge).
// ---------------------------------------------------------------------------
// Posted by the bridge-orchestrator about every minute. Intentionally small
// and decoupled from IngestPayload so the Holochain observer schema is not
// affected. HMAC + replay protection headers are identical to /ingest.
// ---------------------------------------------------------------------------

export interface BridgeSelfHealth {
  uptime_s: number;
  binary_version: string;
  last_cycle_at_iso: string | null;
  last_cycle_ms: number | null;
  consecutive_failed_cycles: number;
  reconnect_failures_total: number;
  reconnects_ok_total: number;
  pressure_active: boolean;
  pressure_consecutive: number;
  stage_ejections_total: number;
  is_stuck: boolean;
  last_error: string | null;
  last_error_at_iso: string | null;
}

export interface BridgeBacklog {
  detected: number;
  queued: number;
  claimed: number;
  in_flight: number;
  succeeded_total: number;
  failed_total: number;
  oldest_queued_age_s: number | null;
}

export interface BridgeThroughput {
  succeeded_1h: number;
  failed_1h: number;
  succeeded_24h: number;
  failed_24h: number;
  avg_time_to_succeed_s_24h: number | null;
}

export interface BridgePayload {
  schema_version: number;
  observer_id: string;
  collected_at: string;
  dna_b64: string;
  self_health: BridgeSelfHealth;
  backlog: BridgeBacklog;
  throughput: BridgeThroughput;
}
