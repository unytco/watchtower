// SPDX-License-Identifier: GPL-3.0-or-later
//
// Copyright (C) 2025-2026 Unyt contributors.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
// General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

//! Reads over a conductor's DHT and conductor databases.
//!
//! Every hash column holds the bare 36 bytes — 0.7 strips the 3-byte hash-type
//! prefix on write — so binds use `get_raw_36()` and reads re-attach the type.
//!
//! "Integrated and valid" is two conditions, and both are needed.
//! `Action.record_validity` carries the validity the conductor aggregates from
//! an action's integrated ops — any rejected op rejects the record, otherwise
//! an accepted op accepts it, `NULL` while undecided. But it is *also* written
//! as `Accepted` the moment a **self-authored** action is committed, before any
//! of its ops integrate. So integration is asserted separately, with
//! [`INTEGRATED`]: an action has integrated here once it has a `ChainOp` row.
//! Testing existence rather than joining keeps one row per action — an action
//! produces several ops, so a join would need de-duplicating.

use crate::{HcOpsError, HcOpsResult};
use holo_hash::AgentPubKey;
use holochain_data::models::dht::{ActionRow, LimboChainOpRow, WarrantRow};
use holochain_integrity_types::prelude::{ActionType, RecordValidity};
use holochain_zome_types::prelude::Entry;
use sqlx::{AssertSqlSafe, Row};

mod conn;
pub use conn::*;

mod model;
pub use model::*;

/// The three `format!`-built queries below are assembled only from the column
/// constants in this module and a count of `?` placeholders — no caller input
/// reaches the SQL — so `AssertSqlSafe` is sound. They are built rather than
/// written out so the column lists stay in one place, matching the row structs
/// `holochain_data` owns.
///
/// Column list for a full [`ActionRow`], qualified with the alias `a`.
const ACTION_COLUMNS: &str = "a.hash, a.author, a.seq, a.prev_hash, a.timestamp, \
     a.action_type, a.action_data, a.signature, a.entry_hash, a.private_entry, \
     a.record_validity";

/// Column list for a full [`LimboChainOpRow`], qualified with the alias `l`.
const LIMBO_OP_COLUMNS: &str = "l.hash, l.op_type, l.action_hash, l.basis_hash, \
     l.storage_center_loc, l.sys_validation_status, l.app_validation_status, \
     l.abandoned_at, l.require_receipt, l.when_received, l.sys_validation_attempts, \
     l.app_validation_attempts, l.last_validation_attempt, l.serialized_size";

/// An [`ActionRow`] plus the public entry it references, when one is stored.
#[derive(sqlx::FromRow)]
struct ActionWithEntry {
    #[sqlx(flatten)]
    action: ActionRow,
    entry_blob: Option<Vec<u8>>,
}

/// A [`WarrantRow`] plus the `WarrantOp.validation_status` it is joined to.
#[derive(sqlx::FromRow)]
struct WarrantWithStatus {
    #[sqlx(flatten)]
    warrant: WarrantRow,
    validation_status: i64,
}

/// Predicate: the action aliased `a` has at least one op integrated on this
/// node. See the module docs for why `record_validity` alone is not enough.
pub(crate) const INTEGRATED: &str =
    "EXISTS (SELECT 1 FROM ChainOp WHERE ChainOp.action_hash = a.hash)";

fn accepted() -> i64 {
    i64::from(RecordValidity::Accepted)
}

/// Every block span recorded in the conductor database.
pub async fn get_blocks(conductor: &HolochainDb) -> HcOpsResult<Vec<BlockRecord>> {
    let rows: Vec<BlockSpanRow> = sqlx::query_as(
        "SELECT id, target_id, target_reason, start_us, end_us
           FROM BlockSpan ORDER BY start_us ASC",
    )
    .fetch_all(conductor.pool())
    .await?;

    rows.into_iter().map(TryInto::try_into).collect()
}

/// Agents this node has seen join the DNA — those with an accepted
/// `AgentValidationPkg` action in the DHT database.
pub async fn list_discovered_agents(dht: &HolochainDb) -> HcOpsResult<Vec<AgentPubKey>> {
    let sql = format!(
        "SELECT DISTINCT a.author FROM Action a
          WHERE a.action_type = ? AND a.record_validity = ? AND {INTEGRATED}"
    );
    let rows: Vec<(Vec<u8>,)> = sqlx::query_as(AssertSqlSafe(sql))
        .bind(i64::from(ActionType::AgentValidationPkg))
        .bind(accepted())
        .fetch_all(dht.pool())
        .await?;

    Ok(rows
        .into_iter()
        .map(|(author,)| AgentPubKey::from_raw_36(author))
        .collect())
}

/// One agent's chain as this node holds it: every action of theirs whose
/// validity has been decided, in sequence order, with its public entry.
pub async fn get_agent_chain(
    dht: &HolochainDb,
    agent_pub_key: &AgentPubKey,
) -> HcOpsResult<Vec<ChainRecord>> {
    let sql = format!(
        "SELECT {ACTION_COLUMNS}, e.blob AS entry_blob
           FROM Action a
           LEFT JOIN Entry e ON e.hash = a.entry_hash
          WHERE a.author = ? AND a.record_validity IS NOT NULL AND {INTEGRATED}
          ORDER BY a.seq ASC"
    );

    let rows: Vec<ActionWithEntry> = sqlx::query_as(AssertSqlSafe(sql))
        .bind(agent_pub_key.get_raw_36())
        .fetch_all(dht.pool())
        .await?;

    rows.into_iter().map(chain_record_from_row).collect()
}

fn chain_record_from_row(row: ActionWithEntry) -> HcOpsResult<ChainRecord> {
    // Filtered on `record_validity IS NOT NULL`, so the column is present.
    let validity = row.action.record_validity.ok_or_else(|| {
        HcOpsError::Other("action row selected as decided has no record_validity".into())
    })?;
    Ok(ChainRecord {
        validation_status: ValidationStatus::from_db(validity)?,
        entry: row.entry_blob.map(decode_entry).transpose()?,
        action: action_from_row(row.action)?,
    })
}

fn decode_entry(blob: Vec<u8>) -> HcOpsResult<Entry> {
    Ok(holochain_serialized_bytes::decode(&blob)?)
}

/// Every integrated warrant in the DHT database, oldest first.
///
/// The signed content lives in `Warrant` and the op metadata in `WarrantOp`;
/// a row in `WarrantOp` *is* integration, so no further filter is needed.
pub async fn get_warrants(dht: &HolochainDb) -> HcOpsResult<Vec<WarrantRecord>> {
    let rows: Vec<WarrantWithStatus> = sqlx::query_as(
        "SELECT w.hash, w.author, w.timestamp, w.warrantee, w.proof, w.signature, w.reason,
                o.storage_center_loc, o.when_received, o.when_integrated, o.serialized_size,
                o.validation_status
           FROM Warrant w
           JOIN WarrantOp o ON o.hash = w.hash
          ORDER BY w.timestamp ASC",
    )
    .fetch_all(dht.pool())
    .await?;

    rows.into_iter()
        .map(|r| (r.warrant, r.validation_status).try_into())
        .collect()
}

/// Ops that have not been integrated, with the action and entry they carry.
///
/// Read in two passes rather than one join: `LimboChainOp.hash` and
/// `Action.hash` collide by name, and aliasing them apart would mean restating
/// the column lists that [`holochain_data`]'s row structs own.
pub async fn get_pending_ops(dht: &HolochainDb) -> HcOpsResult<Vec<Record>> {
    let sql = format!("SELECT {LIMBO_OP_COLUMNS} FROM LimboChainOp l");
    let ops: Vec<LimboChainOpRow> = sqlx::query_as(AssertSqlSafe(sql))
        .fetch_all(dht.pool())
        .await?;
    if ops.is_empty() {
        return Ok(Vec::new());
    }

    let action_hashes: Vec<Vec<u8>> = ops.iter().map(|o| o.action_hash.clone()).collect();
    let actions = fetch_actions_with_entries(dht, &action_hashes).await?;

    let mut out = Vec::with_capacity(ops.len());
    for op in ops {
        let Some((action, entry)) = actions.get(&op.action_hash) else {
            // The schema has an FK from `LimboChainOp.action_hash` to `Action`,
            // so this only happens if the row vanished between the two reads.
            tracing::warn!(
                op = ?op.hash,
                "pending op has no action row; skipping"
            );
            continue;
        };
        out.push(Record {
            dht_op: (op, action.hashed.content.header.timestamp.as_micros()).try_into()?,
            action: action.clone(),
            entry: entry.clone(),
        });
    }
    Ok(out)
}

type ActionsByHash = std::collections::HashMap<
    Vec<u8>,
    (
        holochain_zome_types::prelude::SignedActionHashed,
        Option<Entry>,
    ),
>;

async fn fetch_actions_with_entries(
    dht: &HolochainDb,
    hashes: &[Vec<u8>],
) -> HcOpsResult<ActionsByHash> {
    // SQLite's default parameter limit is 999; stay well under it per batch.
    const BATCH: usize = 500;

    let mut out = ActionsByHash::new();
    for chunk in hashes.chunks(BATCH) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT {ACTION_COLUMNS}, e.blob AS entry_blob
               FROM Action a
               LEFT JOIN Entry e ON e.hash = a.entry_hash
              WHERE a.hash IN ({placeholders})"
        );
        let mut query = sqlx::query_as::<_, ActionWithEntry>(AssertSqlSafe(sql));
        for hash in chunk {
            query = query.bind(hash.clone());
        }
        for row in query.fetch_all(dht.pool()).await? {
            let hash = row.action.hash.clone();
            let entry = row.entry_blob.map(decode_entry).transpose()?;
            out.insert(hash, (action_from_row(row.action)?, entry));
        }
    }
    Ok(out)
}

/// Actions per author whose validity has been decided as accepted, highest
/// count first, then by agent key.
pub async fn count_actions_by_author(dht: &HolochainDb) -> HcOpsResult<Vec<(AgentPubKey, i64)>> {
    let sql = format!(
        "SELECT a.author, COUNT(*) AS action_count FROM Action a
          WHERE a.record_validity = ? AND {INTEGRATED}
          GROUP BY a.author"
    );
    let rows = sqlx::query(AssertSqlSafe(sql))
        .bind(accepted())
        .fetch_all(dht.pool())
        .await?;

    let mut out: Vec<(AgentPubKey, i64)> = rows
        .into_iter()
        .map(|row| {
            let author: Vec<u8> = row.try_get("author")?;
            let count: i64 = row.try_get("action_count")?;
            Ok::<_, sqlx::Error>((AgentPubKey::from_raw_36(author), count))
        })
        .collect::<Result<_, _>>()?;

    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    Ok(out)
}

/// The K2 slice hashes this node has computed for the DNA.
pub async fn get_slice_hashes(dht: &HolochainDb) -> HcOpsResult<Vec<SliceHash>> {
    Ok(
        sqlx::query_as("SELECT arc_start, arc_end, slice_index, hash FROM SliceHash")
            .fetch_all(dht.pool())
            .await?,
    )
}
