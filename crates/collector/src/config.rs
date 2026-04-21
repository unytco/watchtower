use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Everything the collector needs to know to do one pass.
///
/// Built from `observer.toml` by the observer binary; passed directly by
/// the CLI when driving ad-hoc exports.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectorConfig {
    /// Identifier shipped with every payload; must be unique per node.
    pub observer_id: String,
    pub holochain: HolochainConfig,
    /// Where Tier-2 export files land.
    pub exports_dir: PathBuf,
    /// How far back the derived-metrics window looks.
    #[serde(default = "default_lag_window_s")]
    pub lag_window_s: i64,
    /// Cap on `validation_coverage` rows we ship per DNA.
    #[serde(default = "default_validation_coverage_bottom_n")]
    pub validation_coverage_bottom_n: i64,
    /// Configurable tags: `{b64: "hf-treasury"}`.
    #[serde(default)]
    pub agent_tags: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub dna_tags: std::collections::HashMap<String, String>,
}

fn default_lag_window_s() -> i64 {
    3600
}
fn default_validation_coverage_bottom_n() -> i64 {
    50
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HolochainConfig {
    pub admin_port: u16,
    pub data_root: PathBuf,
    /// Absolute path to a file containing the lair passphrase, no trailing
    /// newline. Keep the file 0600 and owned by the observer user.
    pub lair_passphrase_file: PathBuf,
}
