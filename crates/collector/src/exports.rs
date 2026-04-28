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
    pub fn agent_chain(
        &self,
        dna: &holo_hash::DnaHash,
        agent: &holo_hash::AgentPubKey,
    ) -> Result<PathBuf> {
        use unyt_watchtower_hc_store::readable::HumanReadableDisplay;
        use unyt_watchtower_hc_store::retrieve;

        let mut key = crate::tier1_key(self.cfg)?;
        let mut dht = retrieve::open_holochain_database(
            &self.cfg.holochain.data_root,
            &retrieve::DbKind::Dht,
            dna,
            key.as_mut(),
        )?;
        let mut cache = retrieve::open_holochain_database(
            &self.cfg.holochain.data_root,
            &retrieve::DbKind::Cache,
            dna,
            crate::tier1_key(self.cfg)?.as_mut(),
        )
        .ok();
        let chain = retrieve::get_agent_chain(&mut dht, cache.as_mut(), agent)?;

        let path = self
            .cfg
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
    pub fn warrants(&self, dna: Option<&holo_hash::DnaHash>) -> Result<PathBuf> {
        use unyt_watchtower_hc_store::readable::HumanReadableDisplay;
        use unyt_watchtower_hc_store::retrieve;

        let dnas: Vec<holo_hash::DnaHash> = match dna {
            Some(d) => vec![d.clone()],
            None => list_dna_dirs(&self.cfg.holochain.data_root)?,
        };

        let mut out: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
        for d in &dnas {
            let mut key = crate::tier1_key(self.cfg)?;
            let mut dht = match retrieve::open_holochain_database(
                &self.cfg.holochain.data_root,
                &retrieve::DbKind::Dht,
                d,
                key.as_mut(),
            ) {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(dna = %d, error = %e, "skipping dna in warrants export");
                    continue;
                }
            };
            let records = retrieve::get_warrants(&mut dht).unwrap_or_default();
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
    pub fn pending_ops(&self, dna: &holo_hash::DnaHash) -> Result<PathBuf> {
        use unyt_watchtower_hc_store::readable::HumanReadableDisplay;
        use unyt_watchtower_hc_store::retrieve;

        let mut key = crate::tier1_key(self.cfg)?;
        let mut dht = retrieve::open_holochain_database(
            &self.cfg.holochain.data_root,
            &retrieve::DbKind::Dht,
            dna,
            key.as_mut(),
        )?;
        let records = retrieve::get_pending_ops(&mut dht)?;
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
        let simplified = unyt_watchtower_chain_doc::simplify_dump(
            &dump,
            input,
            Utc::now().to_rfc3339(),
        )
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

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct PruneReport {
    pub removed_age: u32,
    pub removed_size: u32,
    pub bytes_removed: u64,
}

/// Enumerate every DNA the conductor has a DHT database for. Filenames in
/// `{data_root}/databases/dht/` are the DNA hash in Holochain's canonical
/// `uhC0k…` form (see `open_holochain_database`).
fn list_dna_dirs(data_root: &Path) -> Result<Vec<holo_hash::DnaHash>> {
    use std::str::FromStr;

    let dir = data_root.join("databases").join("dht");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        // SQLite sidecars (`-shm`, `-wal`) live next to the main DB.
        if name.ends_with("-shm") || name.ends_with("-wal") {
            continue;
        }
        match holo_hash::DnaHashB64::from_str(name) {
            Ok(h) => out.push(h.into()),
            Err(e) => {
                tracing::debug!(file = %name, error = %e, "skipping non-DNA file in dht dir");
            }
        }
    }
    Ok(out)
}
