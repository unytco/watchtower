//! Unit tests for `extensions.rs` that use a fresh in-memory SQLite and
//! fabricate the bits of the Holochain authored/dht schema that the
//! extension queries touch.
//!
//! These tests deliberately avoid spinning up a full Holochain conductor:
//! they're meant to catch regressions in the SQL and percentile logic,
//! not to validate our SQL against real Holochain data (integration tests
//! with fixture DBs live separately).

use diesel::connection::SimpleConnection;
use diesel::{Connection, RunQueryDsl, SqliteConnection};
use holo_hash::AgentPubKey;
use unyt_watchtower_hc_store::extensions::{
    count_integrated_ops, count_pending_ops, integration_lag, list_chain_locks,
    list_scheduled_functions, migration_status_by_author, nonce_stats,
    validation_coverage_bottom_n,
};

fn fresh() -> SqliteConnection {
    SqliteConnection::establish(":memory:").expect("open in-memory sqlite")
}

fn apply(sql: &str, conn: &mut SqliteConnection) {
    conn.batch_execute(sql).expect("apply schema");
}

#[test]
fn validation_coverage_returns_bottom_n_by_count() {
    let mut db = fresh();
    apply(
        r#"
        CREATE TABLE ValidationReceipt (op_hash BLOB NOT NULL);
        INSERT INTO ValidationReceipt VALUES (x'01'), (x'02'), (x'02'), (x'03'), (x'03'), (x'03');
        "#,
        &mut db,
    );

    let rows = validation_coverage_bottom_n(&mut db, 2).expect("query ok");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].receipt_count, 1);
    assert_eq!(rows[0].op_hash, vec![0x01]);
    assert_eq!(rows[1].receipt_count, 2);
    assert_eq!(rows[1].op_hash, vec![0x02]);
}

#[test]
fn op_counters_split_pending_vs_integrated() {
    let mut db = fresh();
    apply(
        r#"
        CREATE TABLE DhtOp (
            hash BLOB PRIMARY KEY,
            authored_timestamp INTEGER,
            when_integrated INTEGER
        );
        INSERT INTO DhtOp VALUES (x'aa', 1000, NULL);
        INSERT INTO DhtOp VALUES (x'bb', 1000, 2000);
        INSERT INTO DhtOp VALUES (x'cc', 1500, 3000);
        "#,
        &mut db,
    );

    assert_eq!(count_pending_ops(&mut db).unwrap(), 1);
    assert_eq!(count_integrated_ops(&mut db).unwrap(), 2);
}

#[test]
fn integration_lag_is_zero_when_window_is_empty() {
    let mut db = fresh();
    apply(
        r#"
        CREATE TABLE DhtOp (
            hash BLOB PRIMARY KEY,
            authored_timestamp INTEGER,
            when_integrated INTEGER
        );
        "#,
        &mut db,
    );
    let lag = integration_lag(&mut db, 60).unwrap();
    assert_eq!(lag.sample_size, 0);
    assert_eq!(lag.p50_ms, 0);
    assert_eq!(lag.p99_ms, 0);
}

#[test]
fn nonce_stats_reports_duplicates() {
    let mut db = fresh();
    apply(
        r#"
        CREATE TABLE Nonce (nonce BLOB NOT NULL);
        INSERT INTO Nonce VALUES (x'01'), (x'02'), (x'02'), (x'03'), (x'03'), (x'03');
        "#,
        &mut db,
    );
    let s = nonce_stats(&mut db).unwrap();
    assert_eq!(s.unique_count, 3);
    assert_eq!(s.duplicate_count, 3);
}

/// Integration/validation state of an op, matching the columns
/// `migration_status_by_author` filters on. `validation_status` is the SQL
/// `Int2` Holochain stores (`0 = Valid`, `1 = Rejected`, `2 = Abandoned`);
/// `when_integrated` is NULL until the op is integrated.
#[derive(Clone, Copy)]
enum OpState {
    /// Integrated and validation-passed — the only state that counts.
    IntegratedValid,
    /// Authored but not yet integrated (`when_integrated IS NULL`).
    Unintegrated,
    /// Integrated but validation rejected (`validation_status = 1`).
    Rejected,
}

/// Build the slice of the Action + DhtOp schema `migration_status_by_author`
/// reads and insert `(author, action_type, op_state)` rows. `Action.type`
/// holds the `ActionType` `Display` string, so `CloseChain` / `OpenChain`
/// arrive verbatim — exactly what Holochain writes. Each action gets one
/// `DhtOp` joined on `action_hash = Action.hash`, carrying the integration /
/// validation state, so the test exercises the same integrated-and-valid
/// filter the query enforces.
fn dht_with_actions(rows: &[(&AgentPubKey, &str, OpState)]) -> SqliteConnection {
    let mut db = fresh();
    apply(
        r#"
        CREATE TABLE Action (hash BLOB PRIMARY KEY, "type" TEXT NOT NULL, author BLOB NOT NULL);
        CREATE TABLE DhtOp (
            hash BLOB PRIMARY KEY,
            action_hash BLOB,
            validation_status INTEGER,
            when_integrated INTEGER
        );
        "#,
        &mut db,
    );
    for (i, (author, typ, state)) in rows.iter().enumerate() {
        let action_hash = vec![i as u8; 39];
        diesel::sql_query("INSERT INTO Action (hash, \"type\", author) VALUES (?, ?, ?)")
            .bind::<diesel::sql_types::Binary, _>(action_hash.clone())
            .bind::<diesel::sql_types::Text, _>(*typ)
            .bind::<diesel::sql_types::Binary, _>(author.get_raw_39().to_vec())
            .execute(&mut db)
            .expect("insert action");
        let (validation_status, when_integrated): (i32, Option<i64>) = match state {
            OpState::IntegratedValid => (0, Some(1000)),
            OpState::Unintegrated => (0, None),
            OpState::Rejected => (1, Some(1000)),
        };
        diesel::sql_query(
            "INSERT INTO DhtOp (hash, action_hash, validation_status, when_integrated) VALUES (?, ?, ?, ?)",
        )
        .bind::<diesel::sql_types::Binary, _>(vec![0x80 | i as u8; 39])
        .bind::<diesel::sql_types::Binary, _>(action_hash)
        .bind::<diesel::sql_types::Integer, _>(validation_status)
        .bind::<diesel::sql_types::Nullable<diesel::sql_types::BigInt>, _>(when_integrated)
        .execute(&mut db)
        .expect("insert dht op");
    }
    db
}

#[test]
fn migration_status_derives_closed_open_and_neither() {
    let closer = AgentPubKey::from_raw_36(vec![0x11; 36]);
    let opener = AgentPubKey::from_raw_36(vec![0x22; 36]);
    let busy = AgentPubKey::from_raw_36(vec![0x33; 36]);

    // One in-memory DHT serves the whole per-DNA walk: the migration read runs
    // on the same connection the rest of the collector queries — no extra cell.
    let mut db = dht_with_actions(&[
        (&busy, "Create", OpState::IntegratedValid),
        (&busy, "Create", OpState::IntegratedValid),
        (&closer, "Create", OpState::IntegratedValid),
        (&closer, "CloseChain", OpState::IntegratedValid),
        (&opener, "OpenChain", OpState::IntegratedValid),
    ]);

    let rows = migration_status_by_author(&mut db).expect("query ok");

    // `busy` has neither terminating action, so it is absent: the result only
    // names agents that closed or opened, never the whole fleet.
    assert_eq!(rows.len(), 2);

    let closer_row = rows.iter().find(|r| r.author == closer).unwrap();
    assert!(closer_row.chain_closed && !closer_row.opening_summary_present);

    let opener_row = rows.iter().find(|r| r.author == opener).unwrap();
    assert!(!opener_row.chain_closed && opener_row.opening_summary_present);
}

/// A `CloseChain`/`OpenChain` whose DhtOp is not yet integrated, or was
/// rejected by validation, must NOT be reported — a "migration done" counter
/// reflects only validated migrations, matching `count_actions_by_author`.
#[test]
fn migration_status_ignores_unintegrated_and_rejected_ops() {
    let pending_closer = AgentPubKey::from_raw_36(vec![0x44; 36]);
    let rejected_opener = AgentPubKey::from_raw_36(vec![0x55; 36]);
    let valid_closer = AgentPubKey::from_raw_36(vec![0x66; 36]);

    let mut db = dht_with_actions(&[
        // Close action present but its op hasn't integrated yet → not closed.
        (&pending_closer, "CloseChain", OpState::Unintegrated),
        // Open action present but validation rejected it → not opened.
        (&rejected_opener, "OpenChain", OpState::Rejected),
        // A clean, integrated+valid close is still reported (control).
        (&valid_closer, "CloseChain", OpState::IntegratedValid),
    ]);

    let rows = migration_status_by_author(&mut db).expect("query ok");

    // Only the validated closer surfaces.
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row.author, valid_closer);
    assert!(row.chain_closed && !row.opening_summary_present);
}

#[test]
fn migration_status_empty_dht_yields_no_rows() {
    let mut db = dht_with_actions(&[]);
    assert!(migration_status_by_author(&mut db).unwrap().is_empty());
}

#[test]
fn list_chain_locks_and_scheduled_functions_handle_empty_tables() {
    let mut db = fresh();
    apply(
        r#"
        CREATE TABLE ChainLock (author BLOB, subject BLOB, expires_at INTEGER);
        CREATE TABLE ScheduledFunctions (author BLOB, zome_name TEXT, scheduled_fn TEXT, start INTEGER);
        "#,
        &mut db,
    );
    assert!(list_chain_locks(&mut db).unwrap().is_empty());
    assert!(list_scheduled_functions(&mut db).unwrap().is_empty());
}
