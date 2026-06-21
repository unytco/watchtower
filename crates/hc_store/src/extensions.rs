//! Additional Holochain data sources we need beyond what hc-ops ships with.
//!
//! These rely on the same SQLite connections opened by [`retrieve`](crate::retrieve)
//! plus the admin-websocket client from `holochain_client`.
//!
//! The functions here are intentionally narrow, each returns a Vec of the
//! smallest useful row. The collector layer turns these into Tier-1 DTOs.

use crate::{HcOpsError, HcOpsResult};
use diesel::prelude::*;
use diesel::sql_query;
use diesel::sql_types::{BigInt, Nullable};
use holochain_zome_types::prelude::AgentPubKey;

/// Receipt-count row for a validated DHT op. Use this to surface ops the
/// network is under-validating (bottom-N by receipt count).
#[derive(Debug, Clone)]
pub struct ValidationCoverageRow {
    pub op_hash: Vec<u8>,
    pub receipt_count: i64,
}

/// Count validation receipts per op hash and return the bottom N ops by
/// receipt count. Useful for "which ops are under-validated?".
///
/// `receipts_complete` in `DhtOp` is a hint, but we count the
/// `ValidationReceipt` rows directly so we see missing coverage early.
pub fn validation_coverage_bottom_n(
    dht: &mut SqliteConnection,
    n: i64,
) -> HcOpsResult<Vec<ValidationCoverageRow>> {
    #[derive(QueryableByName, Debug)]
    struct Row {
        #[diesel(sql_type = diesel::sql_types::Binary)]
        op_hash: Vec<u8>,
        #[diesel(sql_type = BigInt)]
        receipt_count: i64,
    }

    // ValidationReceipt(op_hash BLOB, receipt BLOB, when_integrated INTEGER, ...)
    // is an internal Holochain table; we count rows per op_hash.
    let rows: Vec<Row> = sql_query(
        r#"SELECT op_hash, COUNT(*) as receipt_count
           FROM ValidationReceipt
           GROUP BY op_hash
           ORDER BY receipt_count ASC, op_hash ASC
           LIMIT ?"#,
    )
    .bind::<BigInt, _>(n)
    .get_results(dht)?;

    Ok(rows
        .into_iter()
        .map(|r| ValidationCoverageRow {
            op_hash: r.op_hash,
            receipt_count: r.receipt_count,
        })
        .collect())
}

/// One currently-active chain lock.
#[derive(Debug, Clone)]
pub struct ChainLockRow {
    pub author: AgentPubKey,
    pub subject: Vec<u8>,
    pub expires_at_us: i64,
}

/// Active `ChainLock` rows in an authored DB. A chain lock blocks a commit
/// until it expires or is consumed; locks past their expiry are a signal
/// something got stuck.
pub fn list_chain_locks(authored: &mut SqliteConnection) -> HcOpsResult<Vec<ChainLockRow>> {
    #[derive(QueryableByName, Debug)]
    struct Row {
        #[diesel(sql_type = diesel::sql_types::Binary)]
        author: Vec<u8>,
        #[diesel(sql_type = diesel::sql_types::Binary)]
        subject: Vec<u8>,
        #[diesel(sql_type = BigInt)]
        expires_at: i64,
    }

    let rows: Vec<Row> = sql_query(
        r#"SELECT author, subject, expires_at FROM ChainLock ORDER BY expires_at ASC"#,
    )
    .get_results(authored)?;

    rows.into_iter()
        .map(|r| {
            Ok(ChainLockRow {
                author: AgentPubKey::try_from_raw_39(r.author)?,
                subject: r.subject,
                expires_at_us: r.expires_at,
            })
        })
        .collect()
}

#[derive(Debug, Clone)]
pub struct ScheduledFunctionRow {
    pub author: AgentPubKey,
    pub zome: String,
    pub fn_name: String,
    pub scheduled_at_us: i64,
}

/// Scheduled functions waiting to fire in an authored DB.
pub fn list_scheduled_functions(
    authored: &mut SqliteConnection,
) -> HcOpsResult<Vec<ScheduledFunctionRow>> {
    #[derive(QueryableByName, Debug)]
    struct Row {
        #[diesel(sql_type = diesel::sql_types::Binary)]
        author: Vec<u8>,
        #[diesel(sql_type = diesel::sql_types::Text)]
        zome_name: String,
        #[diesel(sql_type = diesel::sql_types::Text)]
        scheduled_fn: String,
        #[diesel(sql_type = BigInt)]
        start: i64,
    }

    let rows: Vec<Row> = sql_query(
        r#"SELECT author, zome_name, scheduled_fn, start
           FROM ScheduledFunctions
           ORDER BY start ASC"#,
    )
    .get_results(authored)?;

    rows.into_iter()
        .map(|r| {
            Ok(ScheduledFunctionRow {
                author: AgentPubKey::try_from_raw_39(r.author)?,
                zome: r.zome_name,
                fn_name: r.scheduled_fn,
                scheduled_at_us: r.start,
            })
        })
        .collect()
}

#[derive(Debug, Clone, Default)]
pub struct NonceStats {
    pub unique_count: i64,
    pub duplicate_count: i64,
}

/// Count nonces in the conductor DB. `Nonce` has (agent, nonce, expires) —
/// duplicates are a sign of replay attempts. Strongly consistent with
/// Holochain's own replay-protection window.
pub fn nonce_stats(conductor: &mut SqliteConnection) -> HcOpsResult<NonceStats> {
    #[derive(QueryableByName, Debug)]
    struct CountRow {
        #[diesel(sql_type = BigInt)]
        c: i64,
    }

    let unique: Vec<CountRow> =
        sql_query("SELECT COUNT(DISTINCT nonce) as c FROM Nonce").get_results(conductor)?;
    let total: Vec<CountRow> =
        sql_query("SELECT COUNT(*) as c FROM Nonce").get_results(conductor)?;

    let unique_count = unique.first().map(|r| r.c).unwrap_or(0);
    let total_count = total.first().map(|r| r.c).unwrap_or(0);
    Ok(NonceStats {
        unique_count,
        duplicate_count: total_count.saturating_sub(unique_count),
    })
}

/// Quick count helpers for op-level metrics. We do these as raw `sql_query`
/// to avoid dragging every column into memory.

pub fn count_pending_ops(dht: &mut SqliteConnection) -> HcOpsResult<i64> {
    count_where(dht, "DhtOp", "when_integrated IS NULL")
}

pub fn count_integrated_ops(dht: &mut SqliteConnection) -> HcOpsResult<i64> {
    count_where(dht, "DhtOp", "when_integrated IS NOT NULL")
}

fn count_where(conn: &mut SqliteConnection, table: &str, where_clause: &str) -> HcOpsResult<i64> {
    #[derive(QueryableByName, Debug)]
    struct Row {
        #[diesel(sql_type = BigInt)]
        c: i64,
    }
    let q = format!("SELECT COUNT(*) as c FROM {table} WHERE {where_clause}");
    let rows: Vec<Row> = sql_query(&q).get_results(conn)?;
    Ok(rows.first().map(|r| r.c).unwrap_or(0))
}

/// Derived integration lag percentiles in milliseconds, over the most recent
/// `window_s` seconds of integrated ops.
#[derive(Debug, Clone, Default)]
pub struct IntegrationLag {
    pub p50_ms: i64,
    pub p99_ms: i64,
    pub integration_rate: f64,
    pub sample_size: i64,
}

pub fn integration_lag(
    dht: &mut SqliteConnection,
    window_s: i64,
) -> HcOpsResult<IntegrationLag> {
    #[derive(QueryableByName, Debug)]
    struct LagRow {
        #[diesel(sql_type = Nullable<BigInt>)]
        lag_us: Option<i64>,
    }

    let now_us: i64 = chrono::Utc::now().timestamp_micros();
    let since_us = now_us - window_s * 1_000_000;

    let rows: Vec<LagRow> = sql_query(
        r#"SELECT (when_integrated - authored_timestamp) as lag_us
           FROM DhtOp
           WHERE when_integrated IS NOT NULL
             AND authored_timestamp IS NOT NULL
             AND when_integrated >= ?
           ORDER BY lag_us ASC"#,
    )
    .bind::<BigInt, _>(since_us)
    .get_results(dht)?;

    let mut lags: Vec<i64> = rows.into_iter().filter_map(|r| r.lag_us).collect();
    lags.sort_unstable();
    let n = lags.len() as i64;
    if n == 0 {
        return Ok(IntegrationLag::default());
    }
    let p50 = lags[(n as usize - 1) * 50 / 100];
    let p99 = lags[(n as usize - 1) * 99 / 100];

    Ok(IntegrationLag {
        p50_ms: p50 / 1000,
        p99_ms: p99 / 1000,
        integration_rate: n as f64 / window_s as f64,
        sample_size: n,
    })
}

/// Per-author migration status, derived from the chain-terminating system
/// actions already present in the DHT DB.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationStatusRow {
    pub author: AgentPubKey,
    /// The agent committed a `CloseChain` action — its chain is closed. On the
    /// old (predecessor) network this is the tail of the migration close:
    /// `close_agent_chain` commits the `ClosingStateSummary` and then issues
    /// `close_chain`. The alliance DNA has no non-migration close path.
    pub chain_closed: bool,
    /// The agent committed an `OpenChain` action — it has opened onto this DNA.
    /// On the new (successor) network this is the tail of `migration_init`,
    /// which commits the `OpeningStateSummary` and then issues `open_chain`.
    pub opening_summary_present: bool,
}

/// Per-author migration flags, read from the **already-open DHT connection**.
///
/// One aggregating query over the `Action`/`DhtOp` tables the collector has
/// already opened for this DNA — no new cell is fetched or scanned. The
/// `Action.type` column stores Holochain's `ActionType` via its `Display`
/// impl, so a `CloseChain` action is the literal string `"CloseChain"` and an
/// `OpenChain` action is `"OpenChain"` (`holochain_types::sql` → `via_display`).
/// Authors with neither action never appear in the result.
///
/// Like [`count_actions_by_author`](crate::retrieve::count_actions_by_author),
/// this counts only **integrated, validation-passed** ops: the `Action` is
/// joined to its `DhtOp` on `DhtOp.action_hash = Action.hash` and restricted to
/// `when_integrated IS NOT NULL` and `validation_status = 0` (`Valid`; the
/// `ValidationStatus` `ToSql` maps `Valid → 0`, `Rejected → 1`, `Abandoned →
/// 2`). A migration counter must reflect *validated* migrations, so a
/// `CloseChain`/`OpenChain` whose op is still un-integrated or was
/// rejected/abandoned is not reported as closed/opened — matching how the
/// observer's other per-author metric treats the chain.
pub fn migration_status_by_author(
    dht: &mut SqliteConnection,
) -> HcOpsResult<Vec<MigrationStatusRow>> {
    #[derive(QueryableByName, Debug)]
    struct Row {
        #[diesel(sql_type = diesel::sql_types::Binary)]
        author: Vec<u8>,
        #[diesel(sql_type = BigInt)]
        closed: i64,
        #[diesel(sql_type = BigInt)]
        opened: i64,
    }

    let rows: Vec<Row> = sql_query(
        r#"SELECT a.author                       AS author,
                  MAX(a.type = 'CloseChain')      AS closed,
                  MAX(a.type = 'OpenChain')       AS opened
             FROM Action a
             JOIN DhtOp o ON o.action_hash = a.hash
            WHERE a.type IN ('CloseChain', 'OpenChain')
              AND o.when_integrated IS NOT NULL
              AND o.validation_status = 0
            GROUP BY a.author"#,
    )
    .get_results(dht)?;

    rows.into_iter()
        .map(|r| {
            Ok(MigrationStatusRow {
                author: AgentPubKey::try_from_raw_39(r.author)?,
                chain_closed: r.closed != 0,
                opening_summary_present: r.opened != 0,
            })
        })
        .collect()
}

/// Cap-grant tag + function count surfaced from the Entry table (authored DB).
#[derive(Debug, Clone)]
pub struct CapGrantRow {
    pub cell_bytes: Vec<u8>,
    pub tag: Option<String>,
    pub function_count: i64,
    pub access_type: String,
}

pub fn list_capability_grants(authored: &mut SqliteConnection) -> HcOpsResult<Vec<CapGrantRow>> {
    #[derive(QueryableByName, Debug)]
    struct Row {
        #[diesel(sql_type = Nullable<diesel::sql_types::Text>)]
        tag: Option<String>,
        #[diesel(sql_type = Nullable<diesel::sql_types::Binary>)]
        functions: Option<Vec<u8>>,
        #[diesel(sql_type = Nullable<diesel::sql_types::Text>)]
        access_type: Option<String>,
    }

    let rows: Vec<Row> = sql_query(
        r#"SELECT tag, functions, access_type
           FROM Entry
           WHERE access_type IS NOT NULL"#,
    )
    .get_results(authored)?;

    Ok(rows
        .into_iter()
        .map(|r| CapGrantRow {
            cell_bytes: Vec::new(),
            tag: r.tag,
            function_count: count_grant_functions(r.functions.as_deref()),
            access_type: r.access_type.unwrap_or_else(|| "Unknown".to_string()),
        })
        .collect())
}

fn count_grant_functions(blob: Option<&[u8]>) -> i64 {
    let Some(blob) = blob else {
        return 0;
    };
    match holochain_serialized_bytes::decode::<_, Vec<(String, String)>>(blob) {
        Ok(v) => v.len() as i64,
        Err(_) => 0,
    }
}

/// Block `HcOpsError` wrapper so the extensions module compiles independently
/// of retrieve internals. Re-exported so callers can discriminate.
pub type Error = HcOpsError;
