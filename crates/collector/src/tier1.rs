//! Tier-1 collection: build a small, readable NodeSnapshot.
//!
//! Shape:
//! 1. Open the conductor DB, enumerate DNAs via the admin websocket.
//! 2. For each DNA, open its DHT / authored / cache DBs via hc_store.
//! 3. Walk the queries in [`unyt_watchtower_hc_store::retrieve`] and
//!    [`unyt_watchtower_hc_store::extensions`], converting to Tier-1 DTOs.
//! 4. Enforce the per-DNA size budget; drop the lowest-value rows first
//!    (slice hashes, then cap grants, then validation coverage) until it
//!    fits.

use crate::{CollectorConfig, CollectorError, Result};
use unyt_watchtower_core::{
    check_dna_snapshot_budget, tag, AgentSummary, AppSummary, BlockSummary, CapGrantSummary,
    ChainLockRow, ChainSummary, ConductorSnapshot, DerivedMetrics, DnaDefinitionSummary,
    DnaSnapshot, NodeSnapshot, ScheduledFunctionRow, SliceHashRow, ValidationCoverageRow,
    WarrantSummary, MAX_DNA_SNAPSHOT_BYTES,
};
use unyt_watchtower_hc_store::{extensions, retrieve};

use chrono::{DateTime, Utc};
use holo_hash::DnaHash;
use std::collections::HashMap;

/// Run one Tier-1 collection pass. This is pure: it never writes files.
pub async fn collect_node_snapshot(
    cfg: &CollectorConfig,
    admin: &holochain_client::AdminWebsocket,
) -> Result<NodeSnapshot> {
    let apps = admin
        .list_apps(None)
        .await
        .map_err(CollectorError::Client)?;

    let mut conductor_snap = conductor_snapshot(cfg, admin).await?;
    conductor_snap.running_apps = apps
        .iter()
        .filter(|a| matches!(a.status, holochain_types::app::AppStatus::Enabled))
        .count() as u32;
    conductor_snap.paused_apps = apps
        .iter()
        .filter(|a| matches!(a.status, holochain_types::app::AppStatus::AwaitingMemproofs))
        .count() as u32;
    conductor_snap.disabled_apps = apps
        .iter()
        .filter(|a| matches!(a.status, holochain_types::app::AppStatus::Disabled(_)))
        .count() as u32;

    let dna_hashes = admin
        .list_dnas()
        .await
        .map_err(CollectorError::Client)?;

    let mut dnas = Vec::with_capacity(dna_hashes.len());
    for dna_hash in &dna_hashes {
        match collect_dna_snapshot(cfg, dna_hash) {
            Ok(snap) => dnas.push(snap),
            Err(e) => {
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

    let blocks = collect_blocks(cfg).unwrap_or_else(|e| {
        tracing::warn!(error = %e, "failed to read blocks");
        Vec::new()
    });

    Ok(NodeSnapshot {
        conductor: conductor_snap,
        dnas,
        apps: app_summaries,
        blocks,
    })
}

async fn conductor_snapshot(
    cfg: &CollectorConfig,
    _admin: &holochain_client::AdminWebsocket,
) -> Result<ConductorSnapshot> {
    let mut key = load_key(cfg)?;
    let mut conductor = retrieve::open_conductor_database(&cfg.holochain.data_root, key.as_mut())?;
    let nonce = extensions::nonce_stats(&mut conductor).unwrap_or_default();
    Ok(ConductorSnapshot {
        holochain_version: None,
        admin_port: Some(cfg.holochain.admin_port),
        running_apps: 0,
        paused_apps: 0,
        disabled_apps: 0,
        nonce_count: nonce.unique_count as u32,
        nonce_duplicate_count: nonce.duplicate_count as u32,
    })
}

fn collect_blocks(cfg: &CollectorConfig) -> Result<Vec<BlockSummary>> {
    let mut key = load_key(cfg)?;
    let mut conductor = retrieve::open_conductor_database(&cfg.holochain.data_root, key.as_mut())?;
    let rows = retrieve::get_blocks(&mut conductor)?;
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

fn collect_dna_snapshot(cfg: &CollectorConfig, dna_hash: &DnaHash) -> Result<DnaSnapshot> {
    let mut key = load_key(cfg)?;

    let mut dht = retrieve::open_holochain_database(
        &cfg.holochain.data_root,
        &retrieve::DbKind::Dht,
        dna_hash,
        key.as_mut(),
    )?;

    let dna_b64 = tag::b64url(&dna_hash.get_raw_39());
    let dna_tag = cfg.dna_tags.get(&dna_b64).cloned();

    // Agents + per-agent action counts (fast path).
    let counts = retrieve::count_actions_by_author(&mut dht)?;
    let count_map: HashMap<Vec<u8>, i64> = counts
        .iter()
        .map(|(k, v)| (k.get_raw_39().to_vec(), *v))
        .collect();

    let mut cache = retrieve::open_holochain_database(
        &cfg.holochain.data_root,
        &retrieve::DbKind::Cache,
        dna_hash,
        load_key(cfg)?.as_mut(),
    )
    .ok();

    let agents_raw = if let Some(cache) = cache.as_mut() {
        retrieve::list_discovered_agents(&mut dht, cache)?
    } else {
        Vec::new()
    };

    // Warrants — these are small (one row per warrant). We ship them all.
    let warrant_records = retrieve::get_warrants(&mut dht).unwrap_or_default();
    let mut issued: HashMap<String, u32> = HashMap::new();
    let mut against: HashMap<String, u32> = HashMap::new();
    let warrants: Vec<WarrantSummary> = warrant_records
        .iter()
        .map(|w| {
            let warrant = w.warrant.data();
            let author_b64 = tag::b64url(&warrant.author.get_raw_39());
            let target_b64 = tag::b64url(&warrant.warrantee.get_raw_39());
            *issued.entry(author_b64.clone()).or_default() += 1;
            *against.entry(target_b64.clone()).or_default() += 1;
            WarrantSummary {
                op_hash_b64: tag::b64url(&w.dht_op.hash.get_raw_39()),
                warrant_type: format!("{:?}", warrant.proof),
                author_b64,
                target_b64,
                ts_iso: ts_to_iso(warrant.timestamp.0),
            }
        })
        .collect();

    let agents: Vec<AgentSummary> = agents_raw
        .into_iter()
        .map(|a| {
            let b64 = tag::b64url(&a.get_raw_39());
            let action_count = count_map.get(&a.get_raw_39().to_vec()).copied().unwrap_or(0) as u32;
            let now = Utc::now().to_rfc3339();
            AgentSummary {
                agent_b64: b64.clone(),
                agent_tag: cfg.agent_tags.get(&b64).cloned(),
                first_seen_iso: now.clone(),
                last_seen_iso: now,
                action_count,
                warrants_issued: issued.get(&b64).copied().unwrap_or(0),
                warrants_against: against.get(&b64).copied().unwrap_or(0),
            }
        })
        .collect();

    let chain_summaries: Vec<ChainSummary> = counts
        .iter()
        .map(|(agent, c)| {
            let b64 = tag::b64url(&agent.get_raw_39());
            let now = Utc::now().to_rfc3339();
            ChainSummary {
                agent_b64: b64,
                action_count: *c as u32,
                first_ts_iso: now.clone(),
                last_ts_iso: now,
            }
        })
        .collect();

    // Slice hashes, chain locks, and scheduled functions live in the
    // per-(dna, agent) authored DB. Enumerate every authored identity this
    // node owns for this DNA, open each DB, and union the rows. A single
    // unreadable authored DB (e.g. wrong key, missing file) should not
    // abort the whole DNA snapshot.
    let mut slice_hashes: Vec<SliceHashRow> = Vec::new();
    let mut chain_locks: Vec<ChainLockRow> = Vec::new();
    let mut scheduled_functions: Vec<ScheduledFunctionRow> = Vec::new();

    let authored_pairs = retrieve::list_authored_identities(&cfg.holochain.data_root)
        .unwrap_or_else(|e| {
            tracing::warn!(error = %e, "list_authored_identities failed");
            Vec::new()
        });

    for (authored_dna, authored_agent) in authored_pairs
        .iter()
        .filter(|(d, _)| d == dna_hash)
    {
        let Ok(mut authored) = retrieve::open_holochain_database(
            &cfg.holochain.data_root,
            &retrieve::DbKind::Authored(authored_agent.clone()),
            authored_dna,
            load_key(cfg)?.as_mut(),
        ) else {
            tracing::warn!(
                dna = %authored_dna,
                agent = %authored_agent,
                "failed to open authored db; skipping"
            );
            continue;
        };

        match retrieve::get_slice_hashes(&mut authored) {
            Ok(rows) => slice_hashes.extend(rows.into_iter().map(|r| SliceHashRow {
                arc_start: r.arc_start as u32,
                arc_end: r.arc_end as u32,
                slice_index: r.slice_index as u64,
                hash_b64: tag::b64url(&r.hash),
            })),
            Err(e) => tracing::warn!(error = %e, "get_slice_hashes failed"),
        }

        match extensions::list_chain_locks(&mut authored) {
            Ok(rows) => chain_locks.extend(rows.into_iter().map(|r| ChainLockRow {
                author_b64: tag::b64url(&r.author.get_raw_39()),
                subject_b64: tag::b64url(&r.subject),
                expires_at_iso: ts_to_iso(r.expires_at_us),
            })),
            Err(e) => tracing::warn!(error = %e, "list_chain_locks failed"),
        }

        match extensions::list_scheduled_functions(&mut authored) {
            Ok(rows) => scheduled_functions.extend(rows.into_iter().map(|r| ScheduledFunctionRow {
                author_b64: tag::b64url(&r.author.get_raw_39()),
                zome: r.zome,
                fn_name: r.fn_name,
                scheduled_at_iso: ts_to_iso(r.scheduled_at_us),
            })),
            Err(e) => tracing::warn!(error = %e, "list_scheduled_functions failed"),
        }
    }

    // Validation coverage bottom-N.
    let coverage_rows =
        extensions::validation_coverage_bottom_n(&mut dht, cfg.validation_coverage_bottom_n)
            .unwrap_or_default();
    let validation_coverage: Vec<ValidationCoverageRow> = coverage_rows
        .into_iter()
        .map(|r| ValidationCoverageRow {
            op_hash_b64: tag::b64url(&r.op_hash),
            receipt_count: r.receipt_count as u32,
        })
        .collect();

    let cap_grant_rows = extensions::list_capability_grants(&mut dht).unwrap_or_default();
    let cap_grants: Vec<CapGrantSummary> = cap_grant_rows
        .into_iter()
        .map(|r| CapGrantSummary {
            app_id: String::new(),
            cell_b64: String::new(),
            tag: r.tag,
            function_count: r.function_count as u32,
            access_type: r.access_type,
        })
        .collect();

    let pending = extensions::count_pending_ops(&mut dht).unwrap_or(0) as u32;
    let integrated = extensions::count_integrated_ops(&mut dht).unwrap_or(0) as u32;

    let lag = extensions::integration_lag(&mut dht, cfg.lag_window_s).unwrap_or_default();
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

/// Trim snapshot fields in a fixed order until the JSON fits under the
/// per-DNA budget. Order reflects "smallest loss of information first".
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
                    snap.chain_summaries.truncate(snap.chain_summaries.len() / 2);
                } else if !snap.agents.is_empty() {
                    snap.agents.truncate(snap.agents.len() / 2);
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

fn load_key(
    cfg: &CollectorConfig,
) -> Result<Option<unyt_watchtower_hc_store::retrieve::Key>> {
    crate::tier1_key(cfg)
}

fn ts_to_iso(micros: i64) -> String {
    let secs = micros / 1_000_000;
    let nanos = ((micros % 1_000_000) as u32) * 1000;
    DateTime::<Utc>::from_timestamp(secs, nanos)
        .map(|d| d.to_rfc3339())
        .unwrap_or_default()
}
