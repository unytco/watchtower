//! Aggregate reads watchtower needs that the conductor's own API does not expose.
//!
//! Each returns the smallest useful row; the collector turns them into Tier-1
//! DTOs. Enum discriminants are bound from the Holochain enums rather than
//! written as literals, so a renumbering upstream moves these queries with it.

use crate::retrieve::HolochainDb;
use crate::{HcOpsError, HcOpsResult};
use holochain_data::models::dht::{CapGrantRow, ChainLockRow as DbChainLockRow};
use holochain_integrity_types::prelude::{
    ActionType, CapAccessType, GrantedFunctions, RecordValidity,
};
use holochain_zome_types::prelude::{AgentPubKey, Entry};
use sqlx::{AssertSqlSafe, Row};

/// Receipt-count row for a validated DHT op. Use this to surface ops the
/// network is under-validating (bottom-N by receipt count).
#[derive(Debug, Clone)]
pub struct ValidationCoverageRow {
    pub op_hash: Vec<u8>,
    pub receipt_count: i64,
}

/// Count validation receipts per op hash and return the bottom N ops by
/// receipt count. Useful for "which ops are under-validated?".
pub async fn validation_coverage_bottom_n(
    dht: &HolochainDb,
    n: i64,
) -> HcOpsResult<Vec<ValidationCoverageRow>> {
    let rows: Vec<(Vec<u8>, i64)> = sqlx::query_as(
        "SELECT op_hash, COUNT(*) AS receipt_count
           FROM ValidationReceipt
          GROUP BY op_hash
          ORDER BY receipt_count ASC, op_hash ASC
          LIMIT ?",
    )
    .bind(n)
    .fetch_all(dht.pool())
    .await?;

    Ok(rows
        .into_iter()
        .map(|(op_hash, receipt_count)| ValidationCoverageRow {
            op_hash,
            receipt_count,
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

/// Active `ChainLock` rows. A chain lock blocks a commit until it expires or is
/// consumed; locks past their expiry are a signal something got stuck.
pub async fn list_chain_locks(dht: &HolochainDb) -> HcOpsResult<Vec<ChainLockRow>> {
    let rows: Vec<DbChainLockRow> = sqlx::query_as(
        "SELECT author, subject, expires_at_timestamp
           FROM ChainLock ORDER BY expires_at_timestamp ASC",
    )
    .fetch_all(dht.pool())
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| ChainLockRow {
            author: AgentPubKey::from_raw_36(r.author),
            subject: r.subject,
            expires_at_us: r.expires_at_timestamp,
        })
        .collect())
}

#[derive(Debug, Clone)]
pub struct ScheduledFunctionRow {
    pub author: AgentPubKey,
    pub zome: String,
    pub fn_name: String,
    pub scheduled_at_us: i64,
}

/// Scheduled functions waiting to fire.
pub async fn list_scheduled_functions(dht: &HolochainDb) -> HcOpsResult<Vec<ScheduledFunctionRow>> {
    let rows: Vec<(Vec<u8>, String, String, i64)> = sqlx::query_as(
        "SELECT author, zome_name, scheduled_fn, start_at
           FROM ScheduledFunction ORDER BY start_at ASC",
    )
    .fetch_all(dht.pool())
    .await?;

    Ok(rows
        .into_iter()
        .map(|(author, zome, fn_name, start_at)| ScheduledFunctionRow {
            author: AgentPubKey::from_raw_36(author),
            zome,
            fn_name,
            scheduled_at_us: start_at,
        })
        .collect())
}

#[derive(Debug, Clone, Default)]
pub struct NonceStats {
    pub unique_count: i64,
    pub duplicate_count: i64,
}

/// Count nonces in the conductor DB. `Nonce` has (agent, nonce, expires) —
/// duplicates are a sign of replay attempts. Strongly consistent with
/// Holochain's own replay-protection window.
pub async fn nonce_stats(conductor: &HolochainDb) -> HcOpsResult<NonceStats> {
    let (unique_count, total_count): (i64, i64) =
        sqlx::query_as("SELECT COUNT(DISTINCT nonce), COUNT(*) FROM Nonce")
            .fetch_one(conductor.pool())
            .await?;

    Ok(NonceStats {
        unique_count,
        duplicate_count: total_count.saturating_sub(unique_count),
    })
}

/// Ops still awaiting validation or integration.
///
/// Since 0.7 an op's state is which table it is in, not a nullable
/// `when_integrated`: pending ops are in `LimboChainOp` / `LimboWarrantOp` and
/// integrated ops in `ChainOp` / `WarrantOp`. Warrants are counted alongside
/// chain ops because the 0.6 `DhtOp` table these counters were written against
/// held both, and because that is how the conductor's own
/// `count_integrated_ops` totals the store.
pub async fn count_pending_ops(dht: &HolochainDb) -> HcOpsResult<i64> {
    let (count,): (i64,) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM LimboChainOp) + (SELECT COUNT(*) FROM LimboWarrantOp)",
    )
    .fetch_one(dht.pool())
    .await?;
    Ok(count)
}

/// Ops that have been integrated.
pub async fn count_integrated_ops(dht: &HolochainDb) -> HcOpsResult<i64> {
    let (count,): (i64,) =
        sqlx::query_as("SELECT (SELECT COUNT(*) FROM ChainOp) + (SELECT COUNT(*) FROM WarrantOp)")
            .fetch_one(dht.pool())
            .await?;
    Ok(count)
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

/// Lag between an op being authored and being integrated here.
///
/// The authoring time lives on the action, not the op, so `ChainOp` is joined
/// to `Action`. Only ops integrated within the window are sampled.
pub async fn integration_lag(dht: &HolochainDb, window_s: i64) -> HcOpsResult<IntegrationLag> {
    let now_us: i64 = chrono::Utc::now().timestamp_micros();
    let since_us = now_us - window_s * 1_000_000;

    let rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT o.when_integrated - a.timestamp AS lag_us
           FROM ChainOp o
           JOIN Action a ON a.hash = o.action_hash
          WHERE o.when_integrated >= ?
          ORDER BY lag_us ASC",
    )
    .bind(since_us)
    .fetch_all(dht.pool())
    .await?;

    let lags: Vec<i64> = rows.into_iter().map(|(lag,)| lag).collect();
    let n = lags.len();
    if n == 0 {
        return Ok(IntegrationLag::default());
    }

    // Already ordered by the query; index the percentiles directly.
    Ok(IntegrationLag {
        p50_ms: lags[percentile_index(n, 50)] / 1000,
        p99_ms: lags[percentile_index(n, 99)] / 1000,
        integration_rate: n as f64 / window_s as f64,
        sample_size: n as i64,
    })
}

/// Nearest-rank index into an ascending sample of `n` values.
///
/// The rank is `ceil(percentile * n / 100)`, so a percentile always lands on or
/// above its share of the sample. The earlier `(n - 1) * p / 100` form rounded
/// the other way and collapsed on small samples — with two values it reported
/// the *lower* one as p99, understating the tail exactly when an operator is
/// watching a quiet node.
fn percentile_index(n: usize, percentile: usize) -> usize {
    debug_assert!(n > 0, "percentile_index requires a non-empty sample");
    let rank = (percentile * n).div_ceil(100).max(1);
    (rank - 1).min(n - 1)
}

#[cfg(test)]
mod tests {
    use super::percentile_index;

    #[test]
    fn percentiles_use_nearest_rank() {
        // A single sample is both percentiles.
        assert_eq!(percentile_index(1, 50), 0);
        assert_eq!(percentile_index(1, 99), 0);

        // Two samples: p50 is the lower, p99 the upper.
        assert_eq!(percentile_index(2, 50), 0);
        assert_eq!(percentile_index(2, 99), 1);

        // Odd sample: p50 is the median.
        assert_eq!(percentile_index(3, 50), 1);

        // A full hundred lands on the 50th and 99th values.
        assert_eq!(percentile_index(100, 50), 49);
        assert_eq!(percentile_index(100, 99), 98);

        // Never past the end.
        assert_eq!(percentile_index(7, 100), 6);
    }
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
/// One aggregating query over the `Action` table the collector has already
/// opened for this DNA — no new cell is fetched or scanned. Authors with
/// neither action never appear in the result.
///
/// Like [`count_actions_by_author`](crate::retrieve::count_actions_by_author),
/// this counts only **integrated, validation-passed** actions: a migration
/// counter must reflect *completed* migrations, so a `CloseChain`/`OpenChain`
/// that is still un-integrated or was rejected is not reported as
/// closed/opened. Both halves are asserted — `record_validity = Accepted` for
/// validity, and an integrated op for integration, because a self-authored
/// action is marked accepted at commit time, before its ops integrate.
pub async fn migration_status_by_author(dht: &HolochainDb) -> HcOpsResult<Vec<MigrationStatusRow>> {
    let close = i64::from(ActionType::CloseChain);
    let open = i64::from(ActionType::OpenChain);

    let sql = format!(
        "SELECT a.author,
                MAX(a.action_type = ?) AS closed,
                MAX(a.action_type = ?) AS opened
           FROM Action a
          WHERE a.action_type IN (?, ?)
            AND a.record_validity = ?
            AND {integrated}
          GROUP BY a.author",
        integrated = crate::retrieve::INTEGRATED
    );

    let rows = sqlx::query(AssertSqlSafe(sql))
        .bind(close)
        .bind(open)
        .bind(close)
        .bind(open)
        .bind(i64::from(RecordValidity::Accepted))
        .fetch_all(dht.pool())
        .await?;

    rows.into_iter()
        .map(|row| {
            Ok(MigrationStatusRow {
                author: AgentPubKey::from_raw_36(row.try_get("author")?),
                chain_closed: row.try_get::<i64, _>("closed")? != 0,
                opening_summary_present: row.try_get::<i64, _>("opened")? != 0,
            })
        })
        .collect::<Result<_, sqlx::Error>>()
        .map_err(HcOpsError::from)
}

/// Cap-grant tag + function count.
#[derive(Debug, Clone)]
pub struct CapGrantRowSummary {
    pub tag: Option<String>,
    pub function_count: i64,
    pub access_type: String,
}

/// Capability grants this node has authored.
///
/// The `CapGrant` index carries the access type and tag; the granted function
/// list is only in the entry itself, and cap-grant entries are private, so the
/// count comes from `PrivateEntry` via the granting action's entry hash.
pub async fn list_capability_grants(dht: &HolochainDb) -> HcOpsResult<Vec<CapGrantRowSummary>> {
    #[derive(sqlx::FromRow)]
    struct Row {
        #[sqlx(flatten)]
        grant: CapGrantRow,
        entry_blob: Option<Vec<u8>>,
    }

    let rows: Vec<Row> = sqlx::query_as(
        "SELECT g.action_hash, g.cap_access, g.tag, p.blob AS entry_blob
           FROM CapGrant g
           JOIN Action a ON a.hash = g.action_hash
           LEFT JOIN PrivateEntry p ON p.hash = a.entry_hash AND p.author = a.author
          ORDER BY g.action_hash",
    )
    .fetch_all(dht.pool())
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| CapGrantRowSummary {
            tag: r.grant.tag,
            function_count: count_grant_functions(r.entry_blob.as_deref()),
            access_type: access_type_label(r.grant.cap_access),
        })
        .collect())
}

/// The stable names the Tier-1 DTO and the dashboard use for a grant's access
/// type. An unrecognised discriminant reads as `Unknown` rather than failing
/// the whole snapshot.
fn access_type_label(cap_access: i64) -> String {
    match CapAccessType::try_from(cap_access) {
        Ok(CapAccessType::Unrestricted) => "Unrestricted",
        Ok(CapAccessType::Transferable) => "Transferable",
        Ok(CapAccessType::Assigned) => "Assigned",
        Err(v) => {
            tracing::warn!(cap_access = v, "unknown cap access discriminant");
            "Unknown"
        }
    }
    .to_string()
}

fn count_grant_functions(blob: Option<&[u8]>) -> i64 {
    let Some(blob) = blob else {
        // The grant's action is indexed but its private entry is not here. The
        // join is proven against a real writer in `tests/real_schema.rs`, so in
        // production this is news, not routine.
        tracing::warn!("cap grant action has no private entry; reporting 0 functions");
        return 0;
    };
    match holochain_serialized_bytes::decode::<_, Entry>(blob) {
        // `All` grants every function, so there is no list to size; it is
        // reported as 0 alongside its `access_type`, which is what says
        // "unrestricted in scope".
        Ok(Entry::CapGrant(grant)) => match grant.functions {
            GrantedFunctions::All => 0,
            GrantedFunctions::Listed(fns) => fns.len() as i64,
        },
        Ok(other) => {
            // The entry-hash join matched something that is not a cap grant.
            tracing::warn!(
                entry = ?std::mem::discriminant(&other),
                "cap grant action's private entry is not a CapGrant"
            );
            0
        }
        Err(e) => {
            // Warn, not debug: the observer runs at `info`, and a grant that
            // silently reports zero functions looks like a grant with none.
            tracing::warn!(error = %e, "could not decode cap grant entry");
            0
        }
    }
}

/// Block `HcOpsError` wrapper so the extensions module compiles independently
/// of retrieve internals. Re-exported so callers can discriminate.
pub type Error = HcOpsError;
