//! Collector: turn Holochain state into Tier-1 Summaries and write Tier-2
//! exports to disk on demand.
//!
//! The collector is a plain library. The observer binary drives it on a
//! timer; the CLI drives it for ad-hoc exports. Neither the Worker nor the
//! dashboard talks to the collector directly.

pub mod config;
pub mod exports;
pub mod tier1;

pub use config::{CollectorConfig, HolochainConfig};
pub use exports::Exporter;
pub use tier1::{Collected, collect_node_snapshot};

/// Load the SQLCipher key from the lair passphrase file. Shared between
/// Tier-1 collection and Tier-2 exports so that every DB open sees the
/// same key derivation.
pub(crate) async fn tier1_key(
    cfg: &CollectorConfig,
) -> Result<Option<unyt_watchtower_hc_store::retrieve::Key>> {
    let passphrase = std::fs::read_to_string(&cfg.holochain.lair_passphrase_file)?;
    let passphrase = passphrase.trim_end_matches('\n');
    let mut locked = sodoken::LockedArray::new(passphrase.len())
        .map_err(|e| CollectorError::Other(format!("sodoken: {e}")))?;
    locked.lock().copy_from_slice(passphrase.as_bytes());
    let key =
        unyt_watchtower_hc_store::retrieve::load_database_key(&cfg.holochain.data_root, locked)
            .await?;
    Ok(key)
}

#[derive(Debug, thiserror::Error)]
pub enum CollectorError {
    #[error("hc-store: {0}")]
    HcStore(#[from] unyt_watchtower_hc_store::HcOpsError),
    #[error("holochain client: {0:?}")]
    Client(holochain_client::ConductorApiError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("size budget: {0}")]
    Size(#[from] unyt_watchtower_core::SizeBudgetError),
    #[error("other: {0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, CollectorError>;
