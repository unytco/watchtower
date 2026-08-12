//! Tier-2 exports — bulk decoded JSON files dropped under `exports_dir`
//! for the operator to `scp` back.
//!
//! Every file name is `{kind}_{dna}_{extra}_{ts}.json`. The CLI builds
//! these names; nothing here talks to the Worker.

use crate::{CollectorConfig, CollectorError, Result};
use chrono::Utc;
use std::fs;
use std::path::{Path, PathBuf};

pub struct Exporter<'a> {
    cfg: &'a CollectorConfig,
}

impl<'a> Exporter<'a> {
    pub fn new(cfg: &'a CollectorConfig) -> Self {
        Self { cfg }
    }

    fn ts() -> String {
        Utc::now().format("%Y%m%dT%H%M%SZ").to_string()
    }

    fn open(&self, path: &Path) -> Result<std::fs::File> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        Ok(fs::File::create(path)?)
    }

    /// Write the full chain of one agent in one DNA. Uses hc_store +
    /// human_readable to produce a JSON file with decoded entries.
    pub async fn agent_chain(
        &self,
        dna: &holo_hash::DnaHash,
        agent: &holo_hash::AgentPubKey,
    ) -> Result<PathBuf> {
        use unyt_watchtower_hc_store::readable::HumanReadableDisplay;
        use unyt_watchtower_hc_store::retrieve;

        let key = crate::tier1_key(self.cfg).await?;
        let dht =
            retrieve::open_dht_database(&self.cfg.holochain.data_root, dna, key.as_ref()).await?;
        let chain = retrieve::get_agent_chain(&dht, agent).await;
        dht.close().await;
        let chain = chain?;

        let path =
            self.cfg
                .exports_dir
                .join(format!("chain_{}_{}_{}.json", dna, agent, Self::ts()));

        let pretty = <Vec<_> as HumanReadableDisplay>::as_human_readable_pretty(&chain)
            .map_err(|e| CollectorError::Other(format!("readable: {e}")))?;
        let mut file = self.open(&path)?;
        use std::io::Write;
        file.write_all(pretty.as_bytes())?;
        Ok(path)
    }

    /// Dump every integrated warrant in one DNA (or in every DNA if `dna`
    /// is `None`) with full decoded proofs and warrantor signatures. The
    /// observer's tags are not consulted; raw base64url hashes are written.
    pub async fn warrants(&self, dna: Option<&holo_hash::DnaHash>) -> Result<PathBuf> {
        use unyt_watchtower_hc_store::readable::HumanReadableDisplay;
        use unyt_watchtower_hc_store::retrieve;

        let dnas: Vec<holo_hash::DnaHash> = match dna {
            Some(d) => vec![d.clone()],
            None => retrieve::list_dna_databases(&self.cfg.holochain.data_root)?,
        };

        let key = crate::tier1_key(self.cfg).await?;
        let mut out: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
        for d in &dnas {
            // A failure goes in the file, not just the log. This artifact is
            // what an operator copies off the host to answer "was this agent
            // warranted?"; an empty array would answer "no".
            let dht = match retrieve::open_dht_database(
                &self.cfg.holochain.data_root,
                d,
                key.as_ref(),
            )
            .await
            {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(dna = %d, error = %e, "could not open dna for warrants export");
                    out.insert(d.to_string(), export_error(&e));
                    continue;
                }
            };
            let records = retrieve::get_warrants(&dht).await;
            dht.close().await;
            let records = match records {
                Ok(records) => records,
                Err(e) => {
                    tracing::warn!(dna = %d, error = %e, "get_warrants failed");
                    out.insert(d.to_string(), export_error(&e));
                    continue;
                }
            };
            let pretty = <Vec<_> as HumanReadableDisplay>::as_human_readable_pretty(&records)
                .map_err(|e| CollectorError::Other(format!("readable: {e}")))?;
            let value: serde_json::Value = serde_json::from_str(&pretty)?;
            out.insert(d.to_string(), value);
        }

        let suffix = match dna {
            Some(d) => format!("{d}"),
            None => "all".to_string(),
        };
        let path = self
            .cfg
            .exports_dir
            .join(format!("warrants_{}_{}.json", suffix, Self::ts()));
        let body = serde_json::to_string_pretty(&serde_json::Value::Object(out))?;
        let mut file = self.open(&path)?;
        use std::io::Write;
        file.write_all(body.as_bytes())?;
        Ok(path)
    }

    /// Dump every pending op (including bodies) for one DNA.
    pub async fn pending_ops(&self, dna: &holo_hash::DnaHash) -> Result<PathBuf> {
        use unyt_watchtower_hc_store::readable::HumanReadableDisplay;
        use unyt_watchtower_hc_store::retrieve;

        let key = crate::tier1_key(self.cfg).await?;
        let dht =
            retrieve::open_dht_database(&self.cfg.holochain.data_root, dna, key.as_ref()).await?;
        let records = retrieve::get_pending_ops(&dht).await;
        dht.close().await;
        let records = records?;
        let path = self
            .cfg
            .exports_dir
            .join(format!("pending_{}_{}.json", dna, Self::ts()));
        let pretty = <Vec<_> as HumanReadableDisplay>::as_human_readable_pretty(&records)
            .map_err(|e| CollectorError::Other(format!("readable: {e}")))?;
        let mut file = self.open(&path)?;
        use std::io::Write;
        file.write_all(pretty.as_bytes())?;
        Ok(path)
    }

    /// Decode an `hc dump-state` file via the inlined `chain_doc` crate.
    pub fn simplify_state_dump(&self, input: &Path) -> Result<PathBuf> {
        let dump = unyt_watchtower_chain_doc::read_dump(input)
            .map_err(|e| CollectorError::Other(format!("read_dump: {e}")))?;
        let simplified =
            unyt_watchtower_chain_doc::simplify_dump(&dump, input, Utc::now().to_rfc3339())
                .map_err(|e| CollectorError::Other(format!("simplify_dump: {e}")))?;
        let path = self
            .cfg
            .exports_dir
            .join(format!("state_dump_{}.simplified.json", Self::ts()));
        let out = serde_json::to_string_pretty(&simplified)?;
        let mut file = self.open(&path)?;
        use std::io::Write;
        file.write_all(out.as_bytes())?;
        Ok(path)
    }

    /// Janitor: drop files older than max_age_days and, if over max_total_mb,
    /// drop oldest-first until under.
    pub fn prune(&self, max_age_days: u64, max_total_mb: u64) -> Result<PruneReport> {
        let mut entries: Vec<(std::fs::Metadata, PathBuf)> = Vec::new();
        if !self.cfg.exports_dir.exists() {
            return Ok(PruneReport::default());
        }
        for entry in fs::read_dir(&self.cfg.exports_dir)? {
            let entry = entry?;
            let meta = entry.metadata()?;
            if meta.is_file() {
                entries.push((meta, entry.path()));
            }
        }
        entries.sort_by_key(|(m, _)| m.modified().ok());

        let mut report = PruneReport::default();
        let now = std::time::SystemTime::now();
        let age_cutoff = std::time::Duration::from_secs(max_age_days * 24 * 60 * 60);

        for (meta, path) in &entries {
            if let Ok(modified) = meta.modified() {
                if now.duration_since(modified).unwrap_or_default() > age_cutoff {
                    fs::remove_file(path)?;
                    report.removed_age += 1;
                    report.bytes_removed += meta.len();
                }
            }
        }

        let mut total: u64 = entries
            .iter()
            .filter_map(|(m, p)| if p.exists() { Some(m.len()) } else { None })
            .sum();
        let max_bytes = max_total_mb * 1024 * 1024;

        for (meta, path) in &entries {
            if total <= max_bytes {
                break;
            }
            if path.exists() {
                fs::remove_file(path)?;
                total = total.saturating_sub(meta.len());
                report.removed_size += 1;
                report.bytes_removed += meta.len();
            }
        }

        Ok(report)
    }
}

/// Record a per-DNA failure inside the export itself, so a reader cannot
/// mistake "we could not look" for "there was nothing there".
fn export_error(error: &dyn std::fmt::Display) -> serde_json::Value {
    serde_json::json!({ "error": error.to_string() })
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct PruneReport {
    pub removed_age: u32,
    pub removed_size: u32,
    pub bytes_removed: u64,
}
