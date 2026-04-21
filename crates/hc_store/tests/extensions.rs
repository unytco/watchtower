//! Unit tests for `extensions.rs` that use a fresh in-memory SQLite and
//! fabricate the bits of the Holochain authored/dht schema that the
//! extension queries touch.
//!
//! These tests deliberately avoid spinning up a full Holochain conductor:
//! they're meant to catch regressions in the SQL and percentile logic,
//! not to validate our SQL against real Holochain data (integration tests
//! with fixture DBs live separately).

use diesel::connection::SimpleConnection;
use diesel::{Connection, SqliteConnection};
use unyt_watchtower_hc_store::extensions::{
    count_integrated_ops, count_pending_ops, integration_lag, list_chain_locks,
    list_scheduled_functions, nonce_stats, validation_coverage_bottom_n,
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
