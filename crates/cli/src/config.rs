//! The CLI reads the same `observer.toml` the daemon does and produces a
//! `CollectorConfig` from it. Kept in sync with `crates/observer/src/config.rs`.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use unyt_watchtower_collector::{CollectorConfig, HolochainConfig as CollectorHolochain};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObserverConfig {
    pub observer_id: String,
    pub holochain: Holochain,
    pub collection: Collection,
    pub exports: Exports,
    #[serde(default)]
    pub agent_tags: HashMap<String, String>,
    #[serde(default)]
    pub dna_tags: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Holochain {
    pub admin_port: u16,
    pub data_root: PathBuf,
    pub lair_passphrase_file: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Collection {
    #[serde(default = "default_interval_s")]
    pub interval_s: u64,
    #[serde(default = "default_lag_window_s")]
    pub lag_window_s: i64,
    #[serde(default = "default_validation_coverage_bottom_n")]
    pub validation_coverage_bottom_n: i64,
}

fn default_interval_s() -> u64 {
    3600
}
fn default_lag_window_s() -> i64 {
    3600
}
fn default_validation_coverage_bottom_n() -> i64 {
    50
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Exports {
    pub dir: PathBuf,
    #[serde(default = "default_max_age_days")]
    pub max_age_days: u64,
    #[serde(default = "default_max_total_mb")]
    pub max_total_mb: u64,
}

fn default_max_age_days() -> u64 {
    7
}
fn default_max_total_mb() -> u64 {
    5000
}

pub fn load(path: &Path) -> Result<ObserverConfig> {
    let body = std::fs::read_to_string(path)?;
    let cfg: ObserverConfig = toml::from_str(&body)?;
    Ok(cfg)
}

pub fn save(path: &Path, cfg: &ObserverConfig) -> Result<()> {
    let out = toml::to_string_pretty(cfg)?;
    std::fs::write(path, out)?;
    Ok(())
}

impl ObserverConfig {
    pub fn to_collector(&self) -> CollectorConfig {
        CollectorConfig {
            observer_id: self.observer_id.clone(),
            holochain: CollectorHolochain {
                admin_port: self.holochain.admin_port,
                data_root: self.holochain.data_root.clone(),
                lair_passphrase_file: self.holochain.lair_passphrase_file.clone(),
            },
            exports_dir: self.exports.dir.clone(),
            lag_window_s: self.collection.lag_window_s,
            validation_coverage_bottom_n: self.collection.validation_coverage_bottom_n,
            agent_tags: self.agent_tags.clone(),
            dna_tags: self.dna_tags.clone(),
        }
    }
}
