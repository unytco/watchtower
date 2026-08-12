//! Tier-1 collection: build a small, readable NodeSnapshot.
//!
//! Shape:
//! 1. Open the conductor DB, enumerate DNAs via the admin websocket.
//! 2. For each DNA, open its DHT database via hc_store.
//! 3. Walk the queries in [`unyt_watchtower_hc_store::retrieve`] and
//!    [`unyt_watchtower_hc_store::extensions`], converting to Tier-1 DTOs.
//! 4. Enforce the per-DNA size budget; drop the lowest-value rows first
//!    (slice hashes, then cap grants, then validation coverage) until it
//!    fits.

use crate::{CollectorConfig, CollectorError, Result};
use unyt_watchtower_core::{
    AgentSummary, AppSummary, BlockSummary, CapGrantSummary, ChainLockRow, ChainSummary,
    ConductorSnapshot, DerivedMetrics, DnaDefinitionSummary, DnaSnapshot, MAX_DNA_SNAPSHOT_BYTES,
    NodeSnapshot, ScheduledFunctionRow, SliceHashRow, ValidationCoverageRow, WarrantProofSummary,
    WarrantSummary, check_dna_snapshot_budget, tag,
};
use unyt_watchtower_hc_store::retrieve::{ValidationStatus, WarrantRecord};
use unyt_watchtower_hc_store::{extensions, retrieve};

use chrono::{DateTime, Utc};
use holo_hash::DnaHash;
use holochain_zome_types::prelude::{ChainIntegrityWarrant, WarrantProof};
use std::collections::HashMap;

/// What one collection pass produced: the snapshot, and how many reads had to
/// be degraded to get it.
///
/// The count exists because every degradation below reports an empty or zero
/// value that is indistinguishable from a genuinely quiet network. It reaches
/// the ingest payload as `SelfHealth::n_errors_this_cycle`, which alerts fire
/// off — without it, a node whose reads broke after a Holochain upgrade shows
/// green and the only evidence is `journalctl` on that host.
pub struct Collected {
    pub node: NodeSnapshot,
    pub degraded_reads: u32,
}

/// Counts reads this pass had to degrade. Shared across the whole pass, so one
/// number covers the conductor reads and every DNA.
#[derive(Default)]
pub(crate) struct DegradedReads(std::sync::atomic::AtomicU32);

impl DegradedReads {
    fn record(&self) {
        self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    fn count(&self) -> u32 {
        self.0.load(std::sync::atomic::Ordering::Relaxed)
    }
}

/// Run one Tier-1 collection pass. This is pure: it never writes files.
pub async fn collect_node_snapshot(
    cfg: &CollectorConfig,
    admin: &holochain_client::AdminWebsocket,
) -> Result<Collected> {
    let degraded = DegradedReads::default();
    let apps = admin
        .list_apps(None)
        .await
        .map_err(CollectorError::Client)?;

    // One key unlock per pass: deriving it runs argon2, which is deliberately
    // slow, and every database this pass opens uses the same key.
    let key = crate::tier1_key(cfg).await?;
    let conductor =
        retrieve::open_conductor_database(&cfg.holochain.data_root, key.as_ref()).await?;

    // A failed read here reports `nonce_duplicate_count: 0`, which is the
    // "no replay attempts" value — hence the count, not just the log.
    let nonce = warn_on_err(
        extensions::nonce_stats(&conductor).await,
        "nonce_stats",
        &degraded,
    );

    let conductor_snap = ConductorSnapshot {
        holochain_version: None,
        admin_port: Some(cfg.holochain.admin_port),
        running_apps: count_status(&apps, |s| {
            matches!(s, holochain_types::app::AppStatus::Enabled)
        }),
        paused_apps: count_status(&apps, |s| {
            matches!(s, holochain_types::app::AppStatus::AwaitingMemproofs)
        }),
        disabled_apps: count_status(&apps, |s| {
            matches!(s, holochain_types::app::AppStatus::Disabled(_))
        }),
        nonce_count: nonce.unique_count as u32,
        nonce_duplicate_count: nonce.duplicate_count as u32,
    };

    let blocks = warn_on_err(collect_blocks(&conductor).await, "get_blocks", &degraded);
    conductor.close().await;

    let dna_hashes = admin.list_dnas().await.map_err(CollectorError::Client)?;

    let mut dnas = Vec::with_capacity(dna_hashes.len());
    for dna_hash in &dna_hashes {
        match collect_dna_snapshot(cfg, dna_hash, key.as_ref(), &degraded).await {
            Ok(snap) => dnas.push(snap),
            Err(e) => {
                degraded.record();
                tracing::warn!(
                    dna = %dna_hash,
                    error = %e,
                    "failed to collect dna snapshot; skipping"
                );
            }
        }
    }

    let app_summaries: Vec<AppSummary> = apps
        .iter()
        .map(|a| AppSummary {
            app_id: a.installed_app_id.clone(),
            happ_name: a.installed_app_id.clone(),
            role_name: "primary".to_string(),
            clone_of_app_id: None,
        })
        .collect();

    Ok(Collected {
        node: NodeSnapshot {
            conductor: conductor_snap,
            dnas,
            apps: app_summaries,
            blocks,
        },
        degraded_reads: degraded.count(),
    })
}

fn count_status(
    apps: &[holochain_conductor_api::AppInfo],
    pred: impl Fn(&holochain_types::app::AppStatus) -> bool,
) -> u32 {
    apps.iter().filter(|a| pred(&a.status)).count() as u32
}

async fn collect_blocks(conductor: &retrieve::HolochainDb) -> Result<Vec<BlockSummary>> {
    let rows = retrieve::get_blocks(conductor).await?;
    Ok(rows
        .into_iter()
        .map(|b| BlockSummary {
            target_id: format!("{:?}", b.target),
            reason: format!("{:?}", b.reason),
            start_iso: ts_to_iso(b.start.0),
            end_iso: ts_to_iso(b.end.0),
        })
        .collect())
}

async fn collect_dna_snapshot(
    cfg: &CollectorConfig,
    dna_hash: &DnaHash,
    key: Option<&retrieve::Key>,
    degraded: &DegradedReads,
) -> Result<DnaSnapshot> {
    // Since 0.7 one database per DNA holds everything this pass reads: ops,
    // actions, chain locks, scheduled functions, cap grants and slice hashes.
    let dht = retrieve::open_dht_database(&cfg.holochain.data_root, dna_hash, key).await?;
    let snap = collect_from_dht(cfg, dna_hash, &dht, degraded).await;
    dht.close().await;
    snap
}

async fn collect_from_dht(
    cfg: &CollectorConfig,
    dna_hash: &DnaHash,
    dht: &retrieve::HolochainDb,
    degraded: &DegradedReads,
) -> Result<DnaSnapshot> {
    let dna_b64 = tag::b64url(dna_hash.get_raw_39());
    let dna_tag = cfg.dna_tags.get(&dna_b64).cloned();

    // Agents + per-agent action counts (fast path).
    let counts = retrieve::count_actions_by_author(dht).await?;
    let count_map: HashMap<Vec<u8>, i64> = counts
        .iter()
        .map(|(k, v)| (k.get_raw_39().to_vec(), *v))
        .collect();

    let agents_raw = retrieve::list_discovered_agents(dht).await?;

    // Warrants — these are small (one row per warrant). We ship them all,
    // and `enforce_budget` will trim them only if everything else has been
    // dropped first.
    let warrant_records = warn_on_err(retrieve::get_warrants(dht).await, "get_warrants", degraded);
    let mut issued: HashMap<String, u32> = HashMap::new();
    let mut against: HashMap<String, u32> = HashMap::new();
    let warrants: Vec<WarrantSummary> = warrant_records
        .iter()
        .map(|w| {
            let summary = warrant_summary(w);
            *issued.entry(summary.author_b64.clone()).or_default() += 1;
            *against.entry(summary.target_b64.clone()).or_default() += 1;
            summary
        })
        .collect();

    // Per-agent migration flags, read from the SAME `dht` connection already
    // open for this DNA — no extra cell is fetched or scanned. Keyed by the
    // agent's raw-39 bytes.
    //
    // Propagated, not degraded: an empty map is indistinguishable from a
    // healthy pre-migration network, and this is the counter operators watch
    // during a migration window. Dropping the whole DNA (logged by the caller)
    // is the honest failure — reporting every agent as un-migrated is not.
    let migration_map: HashMap<Vec<u8>, extensions::MigrationStatusRow> =
        extensions::migration_status_by_author(dht)
            .await?
            .into_iter()
            .map(|r| (r.author.get_raw_39().to_vec(), r))
            .collect();

    let mut agents: Vec<AgentSummary> = agents_raw
        .into_iter()
        .map(|a| {
            // Bind the raw-39 key once: it's the b64 source and both HashMap keys.
            let raw = a.get_raw_39().to_vec();
            let b64 = tag::b64url(&raw);
            let action_count = count_map.get(&raw).copied().unwrap_or(0) as u32;
            let (chain_closed, opening_summary_present) = migration_flags(migration_map.get(&raw));
            let now = Utc::now().to_rfc3339();
            AgentSummary {
                agent_b64: b64.clone(),
                agent_tag: cfg.agent_tags.get(&b64).cloned(),
                first_seen_iso: now.clone(),
                last_seen_iso: now,
                action_count,
                warrants_issued: issued.get(&b64).copied().unwrap_or(0),
                warrants_against: against.get(&b64).copied().unwrap_or(0),
                chain_closed,
                opening_summary_present,
            }
        })
        .collect();

    // A closer/opener is normally also discovered (it joined this DNA with an
    // `AgentValidationPkg`, so `list_discovered_agents` names it). But discovery
    // and the migration read can disagree at the edges — a close whose action
    // reached validity before its `AgentValidationPkg` did — and a migration
    // counter must never under-count. Fold any migration author not already
    // represented into the reported set as a minimal flagged row, still from the
    // same `dht` connection (no new scan).
    append_migration_only_agents(&mut agents, &migration_map, &cfg.agent_tags);

    let chain_summaries: Vec<ChainSummary> = counts
        .iter()
        .map(|(agent, c)| {
            let b64 = tag::b64url(agent.get_raw_39());
            let now = Utc::now().to_rfc3339();
            ChainSummary {
                agent_b64: b64,
                action_count: *c as u32,
                first_ts_iso: now.clone(),
                last_ts_iso: now,
            }
        })
        .collect();

    let slice_hashes: Vec<SliceHashRow> = warn_on_err(
        retrieve::get_slice_hashes(dht).await,
        "get_slice_hashes",
        degraded,
    )
    .into_iter()
    .map(|r| SliceHashRow {
        arc_start: r.arc_start as u32,
        arc_end: r.arc_end as u32,
        slice_index: r.slice_index as u64,
        hash_b64: tag::b64url(&r.hash),
    })
    .collect();

    let chain_locks: Vec<ChainLockRow> = warn_on_err(
        extensions::list_chain_locks(dht).await,
        "list_chain_locks",
        degraded,
    )
    .into_iter()
    .map(|r| ChainLockRow {
        author_b64: tag::b64url(r.author.get_raw_39()),
        subject_b64: tag::b64url(&r.subject),
        expires_at_iso: ts_to_iso(r.expires_at_us),
    })
    .collect();

    let scheduled_functions: Vec<ScheduledFunctionRow> = warn_on_err(
        extensions::list_scheduled_functions(dht).await,
        "list_scheduled_functions",
        degraded,
    )
    .into_iter()
    .map(|r| ScheduledFunctionRow {
        author_b64: tag::b64url(r.author.get_raw_39()),
        zome: r.zome,
        fn_name: r.fn_name,
        scheduled_at_iso: ts_to_iso(r.scheduled_at_us),
    })
    .collect();

    // Validation coverage bottom-N.
    let validation_coverage: Vec<ValidationCoverageRow> = warn_on_err(
        extensions::validation_coverage_bottom_n(dht, cfg.validation_coverage_bottom_n).await,
        "validation_coverage_bottom_n",
        degraded,
    )
    .into_iter()
    .map(|r| ValidationCoverageRow {
        op_hash_b64: tag::b64url(&r.op_hash),
        receipt_count: r.receipt_count as u32,
    })
    .collect();

    let cap_grants: Vec<CapGrantSummary> = warn_on_err(
        extensions::list_capability_grants(dht).await,
        "list_capability_grants",
        degraded,
    )
    .into_iter()
    .map(|r| CapGrantSummary {
        app_id: String::new(),
        cell_b64: String::new(),
        tag: r.tag,
        function_count: r.function_count as u32,
        access_type: r.access_type,
    })
    .collect();

    // Op counters and lag are load-bearing health signals. A failed read still
    // reports zero — the Tier-1 DTO has no "unknown" — so `warn_on_err` logs it
    // loudly; the log is the only thing distinguishing a broken read from an
    // idle node. Giving these fields an explicit unknown is B107.
    let pending = warn_on_err(
        extensions::count_pending_ops(dht).await,
        "count_pending_ops",
        degraded,
    ) as u32;
    let integrated = warn_on_err(
        extensions::count_integrated_ops(dht).await,
        "count_integrated_ops",
        degraded,
    ) as u32;

    let lag = warn_on_err(
        extensions::integration_lag(dht, cfg.lag_window_s).await,
        "integration_lag",
        degraded,
    );
    let derived_metrics = DerivedMetrics {
        integration_rate: lag.integration_rate,
        lag_p50_ms: lag.p50_ms,
        lag_p99_ms: lag.p99_ms,
        pending_backlog: pending,
    };

    let mut snap = DnaSnapshot {
        dna_b64,
        dna_tag,
        dna_definition: Some(DnaDefinitionSummary {
            zomes: Vec::new(),
            properties_summary_json: "{}".to_string(),
            network_seed: None,
        }),
        agents,
        warrants,
        chain_summaries,
        slice_hashes,
        chain_locks,
        scheduled_functions,
        validation_coverage,
        cap_grants,
        derived_metrics,
        pending_ops_count: pending,
        integrated_ops_count: integrated,
    };

    enforce_budget(&mut snap)?;

    Ok(snap)
}

/// Degrade one optional read to its empty value, but never silently: a query
/// that starts failing after a Holochain upgrade would otherwise look exactly
/// like a node with nothing to report.
fn warn_on_err<T: Default, E: std::fmt::Display>(
    result: std::result::Result<T, E>,
    what: &str,
    degraded: &DegradedReads,
) -> T {
    result.unwrap_or_else(|e| {
        degraded.record();
        tracing::warn!(error = %e, query = what, "read failed; reporting empty");
        T::default()
    })
}

/// Trim snapshot fields in a fixed order until the JSON fits under the
/// per-DNA budget. Order reflects "smallest loss of information first".
/// Warrants are higher-value than chain summaries / agents (they represent
/// integrity violations and are usually small) so they are trimmed last.
fn enforce_budget(snap: &mut DnaSnapshot) -> Result<()> {
    for _ in 0..8 {
        match check_dna_snapshot_budget(snap) {
            Ok(_) => return Ok(()),
            Err(_) => {
                if !snap.slice_hashes.is_empty() {
                    snap.slice_hashes.truncate(snap.slice_hashes.len() / 2);
                } else if !snap.cap_grants.is_empty() {
                    snap.cap_grants.truncate(snap.cap_grants.len() / 2);
                } else if !snap.validation_coverage.is_empty() {
                    snap.validation_coverage
                        .truncate(snap.validation_coverage.len() / 2);
                } else if !snap.chain_summaries.is_empty() {
                    snap.chain_summaries
                        .truncate(snap.chain_summaries.len() / 2);
                } else if !snap.agents.is_empty() {
                    snap.agents.truncate(snap.agents.len() / 2);
                } else if !snap.warrants.is_empty() {
                    snap.warrants.truncate(snap.warrants.len() / 2);
                } else {
                    break;
                }
            }
        }
    }

    // Final check: if still too big, error out so the observer can alert on
    // it rather than silently dropping rows.
    let final_size = unyt_watchtower_core::measure(snap)?;
    if final_size > MAX_DNA_SNAPSHOT_BYTES {
        return Err(CollectorError::Other(format!(
            "dna {} still {} bytes after trimming",
            snap.dna_b64, final_size
        )));
    }
    Ok(())
}

/// Project a per-author migration row onto the two `AgentSummary` flags. An
/// absent row (the agent issued neither `CloseChain` nor `OpenChain`) reads as
/// `(false, false)`.
fn migration_flags(row: Option<&extensions::MigrationStatusRow>) -> (bool, bool) {
    match row {
        Some(m) => (m.chain_closed, m.opening_summary_present),
        None => (false, false),
    }
}

/// Append a minimal flagged [`AgentSummary`] for any migration author not
/// already in `agents`, so a closer/opener that discovery missed is still
/// counted. The synthesized row carries only the migration flags (no action
/// count, no warrants — discovery never saw it); `first/last_seen` is "now",
/// the same stamp the discovered rows use this cycle. Keyed by the b64 agent id
/// the rest of the snapshot uses.
fn append_migration_only_agents(
    agents: &mut Vec<AgentSummary>,
    migration_map: &HashMap<Vec<u8>, extensions::MigrationStatusRow>,
    agent_tags: &HashMap<String, String>,
) {
    let seen: std::collections::HashSet<&str> =
        agents.iter().map(|a| a.agent_b64.as_str()).collect();

    let mut extra: Vec<AgentSummary> = migration_map
        .values()
        .filter_map(|row| {
            let b64 = tag::b64url(row.author.get_raw_39());
            if seen.contains(b64.as_str()) {
                return None;
            }
            let now = Utc::now().to_rfc3339();
            Some(AgentSummary {
                agent_b64: b64.clone(),
                agent_tag: agent_tags.get(&b64).cloned(),
                first_seen_iso: now.clone(),
                last_seen_iso: now,
                action_count: 0,
                warrants_issued: 0,
                warrants_against: 0,
                chain_closed: row.chain_closed,
                opening_summary_present: row.opening_summary_present,
            })
        })
        .collect();

    // `migration_map` iterates a HashMap (unordered); sort the appended rows so
    // the snapshot is deterministic across cycles.
    extra.sort_by(|a, b| a.agent_b64.cmp(&b.agent_b64));
    agents.append(&mut extra);
}

fn ts_to_iso(micros: i64) -> String {
    // `rem_euclid`, not `%`: a negative remainder cast to `u32` wraps to ~4.3e9
    // and then overflows when scaled to nanoseconds. Timestamps come from
    // remote-authored signed content, so a negative one is reachable.
    let secs = micros.div_euclid(1_000_000);
    let nanos = (micros.rem_euclid(1_000_000) as u32) * 1000;
    DateTime::<Utc>::from_timestamp(secs, nanos)
        .map(|d| d.to_rfc3339())
        .unwrap_or_default()
}

/// Build a Tier-1 [`WarrantSummary`] from a [`WarrantRecord`].
///
/// Heavy data (signed actions, full chain bodies) is dropped here; we keep
/// short identifiers, the warrantor's signature, the proof variant, and the
/// op's validation status / integration timestamp so the dashboard can show
/// whether the warrant was accepted or rejected.
pub(crate) fn warrant_summary(w: &WarrantRecord) -> WarrantSummary {
    let warrant = w.warrant.data();
    let author_b64 = tag::b64url(warrant.author.get_raw_39());
    let target_b64 = tag::b64url(warrant.warrantee.get_raw_39());
    let signature_b64 = tag::b64url(&w.warrant.signature().0);

    let (warrant_type, proof_summary) = decode_proof(&warrant.proof);

    WarrantSummary {
        op_hash_b64: tag::b64url(w.dht_op.hash.get_raw_39()),
        warrant_type,
        author_b64,
        target_b64,
        ts_iso: ts_to_iso(warrant.timestamp.0),
        authored_ts_iso: ts_to_iso(w.dht_op.authored_timestamp.0),
        integrated_ts_iso: w.dht_op.when_integrated.map(|t| ts_to_iso(t.0)),
        validation_status: w.dht_op.validation_status.map(validation_status_label),
        signature_b64,
        proof_summary,
    }
}

fn decode_proof(proof: &WarrantProof) -> (String, WarrantProofSummary) {
    match proof {
        WarrantProof::ChainIntegrity(inner) => match inner {
            ChainIntegrityWarrant::InvalidChainOp {
                action_author,
                action: (action_hash, _sig),
                chain_op_type,
                // 0.7 also carries a human-readable `reason`; surfacing it would
                // widen the ingest schema, so it stays out of this port.
                reason: _,
            } => (
                "InvalidChainOp".to_string(),
                WarrantProofSummary::InvalidChainOp {
                    action_author_b64: tag::b64url(action_author.get_raw_39()),
                    action_hash_b64: tag::b64url(action_hash.get_raw_39()),
                    chain_op_type: format!("{chain_op_type:?}"),
                },
            ),
            ChainIntegrityWarrant::ChainFork {
                chain_author,
                action_pair: ((a_hash, _a_sig), (b_hash, _b_sig)),
                // 0.7 also carries the forking `seq`; see the note above.
                seq: _,
            } => (
                "ChainFork".to_string(),
                WarrantProofSummary::ChainFork {
                    chain_author_b64: tag::b64url(chain_author.get_raw_39()),
                    action_a_hash_b64: tag::b64url(a_hash.get_raw_39()),
                    action_b_hash_b64: tag::b64url(b_hash.get_raw_39()),
                },
            ),
        },
    }
}

fn validation_status_label(status: ValidationStatus) -> String {
    match status {
        ValidationStatus::Valid => "Valid",
        ValidationStatus::Rejected => "Rejected",
        ValidationStatus::Abandoned => "Abandoned",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    //! Unit tests for the proof decoder. We can't easily build a full
    //! `WarrantRecord` (it owns a `WarrantOp` and a `SignedWarrant`) without
    //! standing up a SQLite DB, but
    //! `decode_proof` is the part that's most likely to drift when
    //! Holochain adds new `ChainIntegrityWarrant` variants — so we cover
    //! that directly here.
    use super::*;
    use holo_hash::{ActionHash, AgentPubKey};
    use holochain_zome_types::prelude::{ChainOpType, Signature};

    fn agent(byte: u8) -> AgentPubKey {
        AgentPubKey::from_raw_36(vec![byte; 36])
    }

    fn action(byte: u8) -> ActionHash {
        ActionHash::from_raw_36(vec![byte; 36])
    }

    fn sig() -> Signature {
        Signature([0u8; 64])
    }

    #[test]
    fn decode_invalid_chain_op_keeps_typed_fields() {
        let proof = WarrantProof::ChainIntegrity(ChainIntegrityWarrant::InvalidChainOp {
            action_author: agent(0xaa),
            action: (action(0xbb), sig()),
            chain_op_type: ChainOpType::CreateEntry,
            reason: "entry failed app validation".to_string(),
        });
        let (kind, summary) = decode_proof(&proof);
        assert_eq!(kind, "InvalidChainOp");
        match summary {
            WarrantProofSummary::InvalidChainOp {
                action_author_b64,
                action_hash_b64,
                chain_op_type,
            } => {
                assert_eq!(chain_op_type, "CreateEntry");
                assert_eq!(action_author_b64, tag::b64url(agent(0xaa).get_raw_39()));
                assert_eq!(action_hash_b64, tag::b64url(action(0xbb).get_raw_39()));
            }
            other => panic!("expected InvalidChainOp, got {other:?}"),
        }
    }

    #[test]
    fn decode_chain_fork_carries_both_action_hashes() {
        let proof = WarrantProof::ChainIntegrity(ChainIntegrityWarrant::ChainFork {
            chain_author: agent(0x11),
            action_pair: ((action(0x22), sig()), (action(0x33), sig())),
            seq: 7,
        });
        let (kind, summary) = decode_proof(&proof);
        assert_eq!(kind, "ChainFork");
        match summary {
            WarrantProofSummary::ChainFork {
                chain_author_b64,
                action_a_hash_b64,
                action_b_hash_b64,
            } => {
                assert_eq!(chain_author_b64, tag::b64url(agent(0x11).get_raw_39()));
                assert_eq!(action_a_hash_b64, tag::b64url(action(0x22).get_raw_39()));
                assert_eq!(action_b_hash_b64, tag::b64url(action(0x33).get_raw_39()));
                assert_ne!(action_a_hash_b64, action_b_hash_b64);
            }
            other => panic!("expected ChainFork, got {other:?}"),
        }
    }

    /// Timestamps come from remote-authored signed content, so a negative one
    /// is reachable. Before `rem_euclid`, the negative remainder wrapped
    /// through `as u32` and overflowed when scaled to nanoseconds — a panic in
    /// a debug build, in a daemon that must never panic on bad input.
    #[test]
    fn ts_to_iso_survives_a_negative_timestamp() {
        assert_eq!(ts_to_iso(0), "1970-01-01T00:00:00+00:00");
        // One microsecond before the epoch.
        assert_eq!(ts_to_iso(-1), "1969-12-31T23:59:59.999999+00:00");
        assert_eq!(ts_to_iso(i64::MIN), "");
    }

    #[test]
    fn validation_status_label_is_stable() {
        assert_eq!(validation_status_label(ValidationStatus::Valid), "Valid");
        assert_eq!(
            validation_status_label(ValidationStatus::Rejected),
            "Rejected"
        );
        assert_eq!(
            validation_status_label(ValidationStatus::Abandoned),
            "Abandoned"
        );
    }

    #[test]
    fn migration_flags_project_onto_agent_summary() {
        use unyt_watchtower_hc_store::extensions::MigrationStatusRow;

        // Absent row → no migration signal.
        assert_eq!(migration_flags(None), (false, false));

        let closed = MigrationStatusRow {
            author: agent(0x01),
            chain_closed: true,
            opening_summary_present: false,
        };
        assert_eq!(migration_flags(Some(&closed)), (true, false));

        let opened = MigrationStatusRow {
            author: agent(0x02),
            chain_closed: false,
            opening_summary_present: true,
        };
        assert_eq!(migration_flags(Some(&opened)), (false, true));
    }

    #[test]
    fn append_migration_only_agents_folds_in_undiscovered_closers() {
        use unyt_watchtower_hc_store::extensions::MigrationStatusRow;

        let discovered = agent(0xaa);
        let undiscovered_closer = agent(0xbb);
        let discovered_b64 = tag::b64url(discovered.get_raw_39());
        let closer_b64 = tag::b64url(undiscovered_closer.get_raw_39());

        // One agent was discovered (it has an action count); two agents carry a
        // migration flag — the discovered one and an undiscovered closer.
        let mut agents = vec![AgentSummary {
            agent_b64: discovered_b64.clone(),
            agent_tag: None,
            first_seen_iso: "t".into(),
            last_seen_iso: "t".into(),
            action_count: 7,
            warrants_issued: 0,
            warrants_against: 0,
            chain_closed: true,
            opening_summary_present: false,
        }];

        let mut migration_map = HashMap::new();
        migration_map.insert(
            discovered.get_raw_39().to_vec(),
            MigrationStatusRow {
                author: discovered.clone(),
                chain_closed: true,
                opening_summary_present: false,
            },
        );
        migration_map.insert(
            undiscovered_closer.get_raw_39().to_vec(),
            MigrationStatusRow {
                author: undiscovered_closer.clone(),
                chain_closed: true,
                opening_summary_present: false,
            },
        );

        append_migration_only_agents(&mut agents, &migration_map, &HashMap::new());

        // The discovered agent is not duplicated; the undiscovered closer is
        // folded in as a flagged, action-count-zero row.
        assert_eq!(agents.len(), 2);
        let discovered_row = agents
            .iter()
            .find(|a| a.agent_b64 == discovered_b64)
            .expect("discovered agent kept");
        assert_eq!(discovered_row.action_count, 7);

        let folded = agents
            .iter()
            .find(|a| a.agent_b64 == closer_b64)
            .expect("undiscovered closer folded in");
        assert_eq!(folded.action_count, 0);
        assert!(folded.chain_closed && !folded.opening_summary_present);
    }
}
