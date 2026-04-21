//! Tier-1 DTOs exchanged between observer and Worker.
//!
//! Every field here is small and readable. Hashes are base64url (no pad), 39
//! bytes for Holochain hashes. Timestamps are ISO-8601 UTC strings so the UI
//! and D1 can treat them as TEXT without conversion.

use serde::{Deserialize, Serialize};

/// Root payload posted to the Worker each collection cycle.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestPayload {
    pub schema_version: u32,
    pub observer_id: String,
    /// RFC3339 time this snapshot was taken.
    pub collected_at: String,
    pub self_health: SelfHealth,
    pub node: NodeSnapshot,
}

/// Observer's own health. Uploaded on every cycle; alerts fire off the most
/// recent row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelfHealth {
    pub uptime_s: u64,
    pub last_collection_ms: u64,
    pub n_errors_this_cycle: u32,
    pub binary_version: String,
}

/// Tier-1 view of one conductor.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NodeSnapshot {
    pub conductor: ConductorSnapshot,
    pub dnas: Vec<DnaSnapshot>,
    pub apps: Vec<AppSummary>,
    /// Global-scope rows for this node (reverse blocks at the conductor level).
    pub blocks: Vec<BlockSummary>,
}

/// Conductor-level facts.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConductorSnapshot {
    pub holochain_version: Option<String>,
    pub admin_port: Option<u16>,
    pub running_apps: u32,
    pub paused_apps: u32,
    pub disabled_apps: u32,
    /// Number of unique nonces seen in the conductor DB and how many of
    /// those saw a replay attempt (same nonce used twice within the window).
    pub nonce_count: u32,
    pub nonce_duplicate_count: u32,
}

/// One DNA's Tier-1 bundle. Must fit into [`crate::MAX_DNA_SNAPSHOT_BYTES`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DnaSnapshot {
    /// base64url, no pad, 39 bytes.
    pub dna_b64: String,
    pub dna_tag: Option<String>,
    pub dna_definition: Option<DnaDefinitionSummary>,

    pub agents: Vec<AgentSummary>,
    pub warrants: Vec<WarrantSummary>,
    pub chain_summaries: Vec<ChainSummary>,
    pub slice_hashes: Vec<SliceHashRow>,
    pub chain_locks: Vec<ChainLockRow>,
    pub scheduled_functions: Vec<ScheduledFunctionRow>,
    pub validation_coverage: Vec<ValidationCoverageRow>,
    pub cap_grants: Vec<CapGrantSummary>,
    pub derived_metrics: DerivedMetrics,

    pub pending_ops_count: u32,
    pub integrated_ops_count: u32,
}

/// Zome list + network_seed + properties hash. Properties_json is ALREADY
/// summarised on the observer — do not include the raw blob.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DnaDefinitionSummary {
    pub zomes: Vec<String>,
    pub properties_summary_json: String,
    pub network_seed: Option<String>,
}

/// One agent seen in the DHT (or cache). Action counts are pre-computed so
/// the UI doesn't page through chains.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSummary {
    pub agent_b64: String,
    pub agent_tag: Option<String>,
    pub first_seen_iso: String,
    pub last_seen_iso: String,
    pub action_count: u32,
    pub warrants_issued: u32,
    pub warrants_against: u32,
}

/// A single warrant op. The heavy warrant body (who they cheated, what the
/// conflicting ops were) lives in Tier-2 export files; here we only keep
/// small identifiers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WarrantSummary {
    pub op_hash_b64: String,
    pub warrant_type: String,
    pub author_b64: String,
    pub target_b64: String,
    pub ts_iso: String,
}

/// Per-(dna, agent) chain shape summary. Cheap to fetch, useful to show
/// "Agent X wrote 412 records since 2026-04-01".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainSummary {
    pub agent_b64: String,
    pub action_count: u32,
    pub first_ts_iso: String,
    pub last_ts_iso: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SliceHashRow {
    pub arc_start: u32,
    pub arc_end: u32,
    pub slice_index: u64,
    pub hash_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainLockRow {
    pub author_b64: String,
    pub subject_b64: String,
    pub expires_at_iso: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledFunctionRow {
    pub author_b64: String,
    pub zome: String,
    pub fn_name: String,
    pub scheduled_at_iso: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationCoverageRow {
    pub op_hash_b64: String,
    pub receipt_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapGrantSummary {
    pub app_id: String,
    pub cell_b64: String,
    pub tag: Option<String>,
    pub function_count: u32,
    pub access_type: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DerivedMetrics {
    /// ops integrated per second over the last bucket
    pub integration_rate: f64,
    /// ms from authored_timestamp to when_integrated, p50
    pub lag_p50_ms: i64,
    pub lag_p99_ms: i64,
    pub pending_backlog: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSummary {
    pub app_id: String,
    pub happ_name: String,
    pub role_name: String,
    pub clone_of_app_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockSummary {
    pub target_id: String,
    pub reason: String,
    pub start_iso: String,
    pub end_iso: String,
}
