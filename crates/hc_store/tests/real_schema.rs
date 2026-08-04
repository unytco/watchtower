//! Reads checked against a database Holochain itself created and wrote.
//!
//! Every database here is built by `holochain_data::open_db`, so the schema is
//! the conductor's own embedded migration, and every row is written through
//! `holochain_data`'s writer API from typed Holochain values. That is the whole
//! point: the on-disk encoding of `action_type`, `record_validity`,
//! `validation_status` and the 36-byte hashes is produced by Holochain's code,
//! not restated by the test — so a read here that disagrees with the conductor
//! fails instead of silently returning nothing.
//!
//! The predecessor to this file fabricated a hand-written 0.6 schema with
//! `CREATE TABLE`, which is exactly why the 0.7 breakage it was meant to catch
//! would have gone unnoticed.

use holo_hash::{
    ActionHash, AgentPubKey, AnyLinkableHash, DhtOpHash, DnaHash, EntryHash, ExternalHash,
    HoloHashed, PrimitiveHashType,
};
use holochain_data::dht::{
    InsertChainOp, InsertLimboChainOp, InsertScheduledFunction, InsertWarrant,
};
use holochain_data::kind;
use holochain_data::{DbWrite, HolochainDataConfig, open_db};
use holochain_integrity_types::prelude::{
    Action, ActionData, ActionHeader, AgentValidationPkgData, CapAccessType, CloseChainData,
    CreateData, EntryType, EntryVisibility, OpenChainData, RecordValidity, Signature, SignedHashed,
};
use holochain_zome_types::prelude::{
    BlockTargetId, BlockTargetReason, CapAccess, ChainIntegrityWarrant, ChainOpType, Entry,
    GrantedFunctions, IpBlockReason, MigrationTarget, Timestamp, WarrantProof, ZomeCallCapGrant,
};
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;
use unyt_watchtower_hc_store::retrieve::{HolochainDb, ValidationStatus};
use unyt_watchtower_hc_store::{extensions, retrieve};

/// `from_raw_32_and_type` computes the trailing DHT-location bytes; the DNA
/// hash has to survive a base64 round trip through the database file name,
/// which is checksummed against them.
fn dna() -> DnaHash {
    DnaHash::from_raw_32_and_type(vec![0xd0; 32], holo_hash::hash_type::Dna::new())
}

fn agent(byte: u8) -> AgentPubKey {
    AgentPubKey::from_raw_36(vec![byte; 36])
}

fn action_hash(byte: u8) -> ActionHash {
    ActionHash::from_raw_36(vec![byte; 36])
}

fn op_hash(byte: u8) -> DhtOpHash {
    DhtOpHash::from_raw_36(vec![byte; 36])
}

fn basis(byte: u8) -> AnyLinkableHash {
    ExternalHash::from_raw_36(vec![byte; 36]).into()
}

/// A signed action with a caller-chosen hash, so tests can address rows without
/// recomputing content addresses.
fn signed_action(
    hash_byte: u8,
    author: &AgentPubKey,
    seq: u32,
    timestamp_us: i64,
    data: ActionData,
) -> holochain_zome_types::prelude::SignedActionHashed {
    let action = Action {
        header: ActionHeader {
            author: author.clone(),
            timestamp: Timestamp::from_micros(timestamp_us),
            action_seq: seq,
            prev_action: if seq == 0 {
                None
            } else {
                Some(action_hash(hash_byte.wrapping_sub(1)))
            },
        },
        data,
    };
    let hashed = HoloHashed::with_pre_hashed(action, action_hash(hash_byte));
    SignedHashed::with_presigned(hashed, Signature([hash_byte; 64]))
}

fn create_data(entry_byte: u8) -> ActionData {
    ActionData::Create(CreateData {
        entry_type: EntryType::App(holochain_zome_types::prelude::AppEntryDef {
            entry_index: 0.into(),
            zome_index: 0.into(),
            visibility: EntryVisibility::Public,
        }),
        entry_hash: EntryHash::from_raw_36(vec![entry_byte; 36]),
    })
}

fn close_chain() -> ActionData {
    ActionData::CloseChain(CloseChainData {
        new_target: Some(MigrationTarget::Dna(DnaHash::from_raw_36(vec![0xd1; 36]))),
    })
}

fn open_chain() -> ActionData {
    ActionData::OpenChain(OpenChainData {
        prev_target: MigrationTarget::Dna(DnaHash::from_raw_36(vec![0xd0; 36])),
        close_hash: action_hash(0xfe),
    })
}

fn agent_validation_pkg() -> ActionData {
    ActionData::AgentValidationPkg(AgentValidationPkgData {
        membrane_proof: None,
    })
}

/// Create the `databases/` directory a conductor would, and open a real DHT
/// database inside it via Holochain's own migrator.
async fn new_dht_db(data_root: &Path, key: Option<holochain_data::DbKey>) -> DbWrite<kind::Dht> {
    let databases = data_root.join("databases");
    std::fs::create_dir_all(&databases).unwrap();
    let mut config = HolochainDataConfig::default();
    if let Some(key) = key {
        config = config.with_key(key);
    }
    open_db(&databases, kind::Dht::new(Arc::new(dna())), config)
        .await
        .expect("open dht db")
}

async fn new_conductor_db(data_root: &Path) -> DbWrite<kind::Conductor> {
    let databases = data_root.join("databases");
    std::fs::create_dir_all(&databases).unwrap();
    open_db(&databases, kind::Conductor, HolochainDataConfig::default())
        .await
        .expect("open conductor db")
}

/// Insert an action together with one integrated `ChainOp` for it.
async fn insert_integrated(
    db: &DbWrite<kind::Dht>,
    action: &holochain_zome_types::prelude::SignedActionHashed,
    op_byte: u8,
    validity: RecordValidity,
    when_integrated_us: i64,
) {
    db.insert_action(action, Some(validity)).await.unwrap();
    db.insert_chain_op(InsertChainOp {
        op_hash: &op_hash(op_byte),
        action_hash: action.as_hash(),
        op_type: i64::from(ChainOpType::CreateRecord),
        basis_hash: &basis(op_byte),
        storage_center_loc: 42,
        validation_status: validity,
        locally_validated: true,
        require_receipt: false,
        when_received: Timestamp::from_micros(when_integrated_us - 1_000),
        when_integrated: Timestamp::from_micros(when_integrated_us),
        serialized_size: 128,
    })
    .await
    .unwrap();
}

/// Insert an action whose op is still in limbo, so its record validity is
/// undecided — the state a not-yet-integrated migration action is in.
async fn insert_pending(
    db: &DbWrite<kind::Dht>,
    action: &holochain_zome_types::prelude::SignedActionHashed,
    op_byte: u8,
) {
    db.insert_action(action, None).await.unwrap();
    db.insert_limbo_chain_op(InsertLimboChainOp {
        op_hash: &op_hash(op_byte),
        action_hash: action.as_hash(),
        op_type: i64::from(ChainOpType::CreateRecord),
        basis_hash: &basis(op_byte),
        storage_center_loc: 7,
        require_receipt: true,
        when_received: Timestamp::from_micros(5_000),
        serialized_size: 64,
    })
    .await
    .unwrap();
}

/// Commit an action the way a conductor commits its *own*: `record_validity`
/// is stamped at flush time, with no op integrated yet.
async fn insert_self_authored_uningtegrated(
    db: &DbWrite<kind::Dht>,
    action: &holochain_zome_types::prelude::SignedActionHashed,
) {
    db.insert_action(action, Some(RecordValidity::Accepted))
        .await
        .unwrap();
}

async fn open_for_read(data_root: &Path) -> HolochainDb {
    retrieve::open_dht_database(data_root, &dna(), None)
        .await
        .expect("hc_store opens the database the conductor wrote")
}

// ---------------------------------------------------------------------------
// migration_status_by_author — the HOT-Swap release counter
// ---------------------------------------------------------------------------

#[tokio::test]
async fn migration_status_counts_only_accepted_close_and_open() {
    let tmp = tempfile::tempdir().unwrap();
    let db = new_dht_db(tmp.path(), None).await;

    let closer = agent(0x11);
    let opener = agent(0x22);
    let busy = agent(0x33);
    let pending_closer = agent(0x44);
    let rejected_opener = agent(0x55);

    insert_integrated(
        &db,
        &signed_action(0x01, &closer, 1, 1_000, close_chain()),
        0x81,
        RecordValidity::Accepted,
        10_000,
    )
    .await;
    insert_integrated(
        &db,
        &signed_action(0x02, &opener, 1, 1_000, open_chain()),
        0x82,
        RecordValidity::Accepted,
        10_000,
    )
    .await;
    // Ordinary traffic must not be reported as a migration.
    insert_integrated(
        &db,
        &signed_action(0x03, &busy, 1, 1_000, create_data(0xa1)),
        0x83,
        RecordValidity::Accepted,
        10_000,
    )
    .await;
    // A close whose op has not integrated yet is not a completed migration.
    insert_pending(
        &db,
        &signed_action(0x04, &pending_closer, 1, 1_000, close_chain()),
        0x84,
    )
    .await;
    // Nor is one validation rejected.
    insert_integrated(
        &db,
        &signed_action(0x05, &rejected_opener, 1, 1_000, open_chain()),
        0x85,
        RecordValidity::Rejected,
        10_000,
    )
    .await;

    let read = open_for_read(tmp.path()).await;
    let rows = extensions::migration_status_by_author(&read).await.unwrap();

    assert_eq!(
        rows.len(),
        2,
        "only the accepted close and open are reported, got {rows:?}"
    );

    let closed = rows.iter().find(|r| r.author == closer).expect("closer");
    assert!(closed.chain_closed && !closed.opening_summary_present);

    let opened = rows.iter().find(|r| r.author == opener).expect("opener");
    assert!(!opened.chain_closed && opened.opening_summary_present);
}

#[tokio::test]
async fn migration_status_reports_an_agent_that_both_closed_and_opened() {
    let tmp = tempfile::tempdir().unwrap();
    let db = new_dht_db(tmp.path(), None).await;
    let mover = agent(0x66);

    insert_integrated(
        &db,
        &signed_action(0x01, &mover, 1, 1_000, close_chain()),
        0x81,
        RecordValidity::Accepted,
        10_000,
    )
    .await;
    insert_integrated(
        &db,
        &signed_action(0x02, &mover, 2, 2_000, open_chain()),
        0x82,
        RecordValidity::Accepted,
        11_000,
    )
    .await;

    let read = open_for_read(tmp.path()).await;
    let rows = extensions::migration_status_by_author(&read).await.unwrap();

    assert_eq!(rows.len(), 1);
    assert!(rows[0].chain_closed && rows[0].opening_summary_present);
}

#[tokio::test]
async fn migration_status_on_an_untouched_dna_is_empty() {
    let tmp = tempfile::tempdir().unwrap();
    let _db = new_dht_db(tmp.path(), None).await;
    let read = open_for_read(tmp.path()).await;
    assert!(
        extensions::migration_status_by_author(&read)
            .await
            .unwrap()
            .is_empty()
    );
}

// ---------------------------------------------------------------------------
// Agents, counts and chains
// ---------------------------------------------------------------------------

#[tokio::test]
async fn discovered_agents_are_those_with_an_accepted_validation_package() {
    let tmp = tempfile::tempdir().unwrap();
    let db = new_dht_db(tmp.path(), None).await;

    let joined = agent(0x11);
    let joining = agent(0x22);

    insert_integrated(
        &db,
        &signed_action(0x01, &joined, 1, 1_000, agent_validation_pkg()),
        0x81,
        RecordValidity::Accepted,
        10_000,
    )
    .await;
    insert_pending(
        &db,
        &signed_action(0x02, &joining, 1, 1_000, agent_validation_pkg()),
        0x82,
    )
    .await;

    let read = open_for_read(tmp.path()).await;
    let agents = retrieve::list_discovered_agents(&read).await.unwrap();
    assert_eq!(agents, vec![joined]);
}

#[tokio::test]
async fn action_counts_are_per_author_and_accepted_only() {
    let tmp = tempfile::tempdir().unwrap();
    let db = new_dht_db(tmp.path(), None).await;

    let busy = agent(0x11);
    let quiet = agent(0x22);

    for (i, byte) in [0x01u8, 0x02, 0x03].iter().enumerate() {
        insert_integrated(
            &db,
            &signed_action(*byte, &busy, i as u32 + 1, 1_000, create_data(0xa0 + byte)),
            0x80 + byte,
            RecordValidity::Accepted,
            10_000,
        )
        .await;
    }
    insert_integrated(
        &db,
        &signed_action(0x04, &quiet, 1, 1_000, create_data(0xa4)),
        0x84,
        RecordValidity::Accepted,
        10_000,
    )
    .await;
    // Rejected work does not count towards an agent's activity.
    insert_integrated(
        &db,
        &signed_action(0x05, &quiet, 2, 1_000, create_data(0xa5)),
        0x85,
        RecordValidity::Rejected,
        10_000,
    )
    .await;

    let read = open_for_read(tmp.path()).await;
    let counts = retrieve::count_actions_by_author(&read).await.unwrap();

    assert_eq!(counts, vec![(busy, 3), (quiet, 1)]);
}

#[tokio::test]
async fn agent_chain_round_trips_the_action_holochain_wrote() {
    let tmp = tempfile::tempdir().unwrap();
    let db = new_dht_db(tmp.path(), None).await;

    let author = agent(0x11);
    let entry = Entry::App(
        holochain_zome_types::prelude::AppEntryBytes::try_from(
            holochain_serialized_bytes::SerializedBytes::from(
                holochain_serialized_bytes::UnsafeBytes::from(vec![1, 2, 3]),
            ),
        )
        .unwrap(),
    );
    let entry_hash = EntryHash::from_raw_36(vec![0xa1; 36]);
    db.insert_entry(&entry_hash, &entry).await.unwrap();

    let action = signed_action(
        0x01,
        &author,
        1,
        1_234_567,
        ActionData::Create(CreateData {
            entry_type: EntryType::App(holochain_zome_types::prelude::AppEntryDef {
                entry_index: 0.into(),
                zome_index: 0.into(),
                visibility: EntryVisibility::Public,
            }),
            entry_hash: entry_hash.clone(),
        }),
    );
    insert_integrated(&db, &action, 0x81, RecordValidity::Accepted, 10_000).await;

    let read = open_for_read(tmp.path()).await;
    let chain = retrieve::get_agent_chain(&read, &author).await.unwrap();

    assert_eq!(chain.len(), 1);
    // The whole signed, hashed action survives the round trip — which only
    // holds if the 36-byte hash columns and the `ActionData` blob are decoded
    // the way Holochain encoded them.
    assert_eq!(chain[0].action, action);
    assert_eq!(chain[0].validation_status, ValidationStatus::Valid);
    assert_eq!(chain[0].entry, Some(entry));
}

#[tokio::test]
async fn agent_chain_reports_a_rejected_record_as_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let db = new_dht_db(tmp.path(), None).await;
    let author = agent(0x11);

    let action = signed_action(0x01, &author, 1, 1_000, create_data(0xa1));
    insert_integrated(&db, &action, 0x81, RecordValidity::Rejected, 10_000).await;

    let read = open_for_read(tmp.path()).await;
    let chain = retrieve::get_agent_chain(&read, &author).await.unwrap();

    assert_eq!(chain.len(), 1);
    assert_eq!(chain[0].validation_status, ValidationStatus::Rejected);
}

// ---------------------------------------------------------------------------
// Op counters and lag
// ---------------------------------------------------------------------------

#[tokio::test]
async fn op_counters_split_limbo_from_integrated() {
    let tmp = tempfile::tempdir().unwrap();
    let db = new_dht_db(tmp.path(), None).await;
    let author = agent(0x11);

    insert_integrated(
        &db,
        &signed_action(0x01, &author, 1, 1_000, create_data(0xa1)),
        0x81,
        RecordValidity::Accepted,
        10_000,
    )
    .await;
    insert_integrated(
        &db,
        &signed_action(0x02, &author, 2, 1_000, create_data(0xa2)),
        0x82,
        RecordValidity::Accepted,
        10_000,
    )
    .await;
    insert_pending(
        &db,
        &signed_action(0x03, &author, 3, 1_000, create_data(0xa3)),
        0x83,
    )
    .await;

    let read = open_for_read(tmp.path()).await;
    assert_eq!(extensions::count_pending_ops(&read).await.unwrap(), 1);
    assert_eq!(extensions::count_integrated_ops(&read).await.unwrap(), 2);
}

#[tokio::test]
async fn integration_lag_measures_authoring_to_integration() {
    let tmp = tempfile::tempdir().unwrap();
    let db = new_dht_db(tmp.path(), None).await;
    let author = agent(0x11);

    // Authored "now", integrated 2s and 4s later; both inside the window.
    let now_us = chrono::Utc::now().timestamp_micros();
    for (i, lag_us) in [2_000_000i64, 4_000_000].iter().enumerate() {
        let byte = 0x01 + i as u8;
        insert_integrated(
            &db,
            &signed_action(
                byte,
                &author,
                i as u32 + 1,
                now_us,
                create_data(0xa0 + byte),
            ),
            0x80 + byte,
            RecordValidity::Accepted,
            now_us + lag_us,
        )
        .await;
    }

    let read = open_for_read(tmp.path()).await;
    let lag = extensions::integration_lag(&read, 3600).await.unwrap();

    assert_eq!(lag.sample_size, 2);
    assert_eq!(lag.p50_ms, 2_000);
    assert_eq!(lag.p99_ms, 4_000);
}

#[tokio::test]
async fn integration_lag_on_an_empty_window_is_zero() {
    let tmp = tempfile::tempdir().unwrap();
    let _db = new_dht_db(tmp.path(), None).await;
    let read = open_for_read(tmp.path()).await;

    let lag = extensions::integration_lag(&read, 60).await.unwrap();
    assert_eq!(lag.sample_size, 0);
    assert_eq!(lag.p50_ms, 0);
    assert_eq!(lag.p99_ms, 0);
}

// ---------------------------------------------------------------------------
// Warrants
// ---------------------------------------------------------------------------

#[tokio::test]
async fn warrants_round_trip_with_their_validation_status() {
    let tmp = tempfile::tempdir().unwrap();
    let db = new_dht_db(tmp.path(), None).await;

    let warrantor = agent(0x11);
    let warrantee = agent(0x22);
    let proof = WarrantProof::ChainIntegrity(ChainIntegrityWarrant::ChainFork {
        chain_author: warrantee.clone(),
        action_pair: (
            (action_hash(0x31), Signature([0x31; 64])),
            (action_hash(0x32), Signature([0x32; 64])),
        ),
        seq: 9,
    });
    let proof_blob = holochain_serialized_bytes::encode(&proof).unwrap();

    db.insert_warrant(InsertWarrant {
        hash: &op_hash(0x81),
        author: &warrantor,
        timestamp: Timestamp::from_micros(1_000),
        warrantee: &warrantee,
        proof: &proof_blob,
        signature: &[0x77; 64],
        reason: Some("forked"),
        storage_center_loc: 11,
        when_received: Timestamp::from_micros(2_000),
        when_integrated: Timestamp::from_micros(3_000),
        validation_status: i64::from(RecordValidity::Accepted),
        serialized_size: 256,
    })
    .await
    .unwrap();

    let read = open_for_read(tmp.path()).await;
    let warrants = retrieve::get_warrants(&read).await.unwrap();

    assert_eq!(warrants.len(), 1);
    let w = &warrants[0];
    assert_eq!(w.dht_op.hash, op_hash(0x81));
    assert_eq!(w.dht_op.validation_status, Some(ValidationStatus::Valid));
    assert_eq!(w.dht_op.when_integrated, Some(Timestamp(3_000)));
    assert_eq!(w.warrant.data().author, warrantor);
    assert_eq!(w.warrant.data().warrantee, warrantee);
    assert_eq!(w.warrant.data().proof, proof);
    assert_eq!(w.warrant.signature().0, [0x77; 64]);
}

// ---------------------------------------------------------------------------
// Per-DNA tables that moved out of the authored database in 0.7
// ---------------------------------------------------------------------------

#[tokio::test]
async fn chain_locks_and_scheduled_functions_read_from_the_dht_database() {
    let tmp = tempfile::tempdir().unwrap();
    let db = new_dht_db(tmp.path(), None).await;
    let author = agent(0x11);

    let acquired = db
        .acquire_chain_lock(
            &author,
            &[0xab, 0xcd],
            Timestamp::from_micros(9_000),
            Timestamp::from_micros(1_000),
        )
        .await
        .unwrap();
    assert!(acquired, "lock should be free on a fresh database");

    let maybe_schedule = holochain_serialized_bytes::encode(
        &Option::<holochain_zome_types::prelude::Schedule>::None,
    )
    .unwrap();
    db.upsert_scheduled_function(InsertScheduledFunction {
        author: &author,
        zome_name: "alliance",
        scheduled_fn: "sweep",
        maybe_schedule: &maybe_schedule,
        start_at: Timestamp::from_micros(4_000),
        end_at: Timestamp::from_micros(8_000),
        ephemeral: false,
    })
    .await
    .unwrap();

    let read = open_for_read(tmp.path()).await;

    let locks = extensions::list_chain_locks(&read).await.unwrap();
    assert_eq!(locks.len(), 1);
    assert_eq!(locks[0].author, author);
    assert_eq!(locks[0].subject, vec![0xab, 0xcd]);
    assert_eq!(locks[0].expires_at_us, 9_000);

    let scheduled = extensions::list_scheduled_functions(&read).await.unwrap();
    assert_eq!(scheduled.len(), 1);
    assert_eq!(scheduled[0].author, author);
    assert_eq!(scheduled[0].zome, "alliance");
    assert_eq!(scheduled[0].fn_name, "sweep");
    assert_eq!(scheduled[0].scheduled_at_us, 4_000);
}

#[tokio::test]
async fn slice_hashes_read_from_the_dht_database() {
    let tmp = tempfile::tempdir().unwrap();
    let db = new_dht_db(tmp.path(), None).await;

    db.insert_slice_hash(0, 100, 7, &[0xaa, 0xbb])
        .await
        .unwrap();

    let read = open_for_read(tmp.path()).await;
    let hashes = retrieve::get_slice_hashes(&read).await.unwrap();

    assert_eq!(hashes.len(), 1);
    assert_eq!(hashes[0].arc_start, 0);
    assert_eq!(hashes[0].arc_end, 100);
    assert_eq!(hashes[0].slice_index, 7);
    assert_eq!(hashes[0].hash, vec![0xaa, 0xbb]);
}

#[tokio::test]
async fn validation_coverage_returns_the_least_witnessed_ops_first() {
    let tmp = tempfile::tempdir().unwrap();
    let db = new_dht_db(tmp.path(), None).await;
    let author = agent(0x11);

    // Receipts have a foreign key onto `ChainOp`, so the ops must exist first.
    for (i, byte) in [0x01u8, 0x02, 0x03].iter().enumerate() {
        insert_integrated(
            &db,
            &signed_action(
                *byte,
                &author,
                i as u32 + 1,
                1_000,
                create_data(0xa0 + byte),
            ),
            0x80 + byte,
            RecordValidity::Accepted,
            10_000,
        )
        .await;
    }

    // op 0x81 gets one receipt, 0x82 two, 0x83 three.
    let mut receipt = 0xc0u8;
    for (op_byte, count) in [(0x81u8, 1), (0x82, 2), (0x83, 3)] {
        for _ in 0..count {
            db.insert_validation_receipt(
                &op_hash(receipt),
                &op_hash(op_byte),
                &[0u8; 8],
                Timestamp::from_micros(1_000),
            )
            .await
            .unwrap();
            receipt += 1;
        }
    }

    let read = open_for_read(tmp.path()).await;
    let rows = extensions::validation_coverage_bottom_n(&read, 2)
        .await
        .unwrap();

    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].receipt_count, 1);
    assert_eq!(rows[0].op_hash, op_hash(0x81).get_raw_36().to_vec());
    assert_eq!(rows[1].receipt_count, 2);
}

#[tokio::test]
async fn capability_grants_report_access_type_and_function_count() {
    let tmp = tempfile::tempdir().unwrap();
    let db = new_dht_db(tmp.path(), None).await;
    let author = agent(0x11);

    let mut functions = BTreeSet::new();
    functions.insert(("alliance".into(), "recv_remote_signal".into()));
    functions.insert(("alliance".into(), "notary_read".into()));
    let grant = ZomeCallCapGrant {
        tag: "notary".to_string(),
        access: CapAccess::Unrestricted,
        functions: GrantedFunctions::Listed(functions.into_iter().collect()),
    };
    let entry = Entry::CapGrant(grant);
    let entry_hash = EntryHash::from_raw_36(vec![0xa1; 36]);

    let action = signed_action(
        0x01,
        &author,
        1,
        1_000,
        ActionData::Create(CreateData {
            entry_type: EntryType::CapGrant,
            entry_hash: entry_hash.clone(),
        }),
    );
    db.insert_action(&action, Some(RecordValidity::Accepted))
        .await
        .unwrap();
    // Cap-grant entries are private, so the content lives in `PrivateEntry`.
    db.insert_private_entry(&entry_hash, &author, &entry)
        .await
        .unwrap();
    db.insert_cap_grant(
        action.as_hash(),
        i64::from(CapAccessType::Unrestricted),
        Some("notary"),
    )
    .await
    .unwrap();

    let read = open_for_read(tmp.path()).await;
    let grants = extensions::list_capability_grants(&read).await.unwrap();

    assert_eq!(grants.len(), 1);
    assert_eq!(grants[0].tag.as_deref(), Some("notary"));
    assert_eq!(grants[0].access_type, "Unrestricted");
    assert_eq!(grants[0].function_count, 2);
}

// ---------------------------------------------------------------------------
// Conductor database
// ---------------------------------------------------------------------------

#[tokio::test]
async fn nonce_stats_count_uniques_and_duplicates() {
    let tmp = tempfile::tempdir().unwrap();
    let db = new_conductor_db(tmp.path()).await;

    // Three distinct nonces, one of them witnessed by two agents.
    for (agent_byte, nonce) in [(0x11u8, 1u32), (0x22, 2), (0x33, 3), (0x44, 3)] {
        sqlx::query("INSERT INTO Nonce (agent, nonce, expires) VALUES (?, ?, ?)")
            .bind(agent(agent_byte).get_raw_36())
            .bind(nonce.to_le_bytes().to_vec())
            .bind(9_000i64)
            .execute(db.pool())
            .await
            .unwrap();
    }

    let read = retrieve::open_conductor_database(tmp.path(), None)
        .await
        .unwrap();
    let stats = extensions::nonce_stats(&read).await.unwrap();

    assert_eq!(stats.unique_count, 3);
    assert_eq!(stats.duplicate_count, 1);
}

// ---------------------------------------------------------------------------
// Opening databases: naming, encryption, and refusing to invent one
// ---------------------------------------------------------------------------

#[tokio::test]
async fn dna_databases_are_found_by_the_name_the_conductor_writes() {
    let tmp = tempfile::tempdir().unwrap();
    let _dht = new_dht_db(tmp.path(), None).await;
    let _conductor = new_conductor_db(tmp.path()).await;

    let found = retrieve::list_dna_databases(tmp.path()).unwrap();
    assert_eq!(
        found,
        vec![dna()],
        "conductor.db must not be mistaken for a DNA"
    );
}

#[tokio::test]
async fn opening_a_missing_database_errors_instead_of_creating_one() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(tmp.path().join("databases")).unwrap();

    let err = retrieve::open_dht_database(tmp.path(), &dna(), None)
        .await
        .expect_err("a missing database must not be conjured into existence");
    assert!(
        err.to_string().contains("no database at"),
        "unexpected error: {err}"
    );

    let expected = tmp
        .path()
        .join("databases")
        .join(format!("dht-{}.db", dna()));
    assert!(
        !expected.exists(),
        "opening for read must not create {}",
        expected.display()
    );
}

#[tokio::test]
async fn encrypted_databases_are_read_through_the_conductors_own_key_file() {
    let tmp = tempfile::tempdir().unwrap();
    let passphrase = b"passphrase".to_vec();

    let db_key = holochain_data::DbKey::generate(Arc::new(std::sync::Mutex::new(
        sodoken::LockedArray::from(passphrase.clone()),
    )))
    .await
    .unwrap();

    let databases = tmp.path().join("databases");
    std::fs::create_dir_all(&databases).unwrap();
    // The conductor persists the locked key next to the databases; `hc_store`
    // must find and unlock it from the data root alone.
    std::fs::write(databases.join("db.key"), db_key.locked.clone()).unwrap();

    let db = new_dht_db(tmp.path(), Some(db_key)).await;
    let mover = agent(0x66);
    insert_integrated(
        &db,
        &signed_action(0x01, &mover, 1, 1_000, close_chain()),
        0x81,
        RecordValidity::Accepted,
        10_000,
    )
    .await;
    db.pool().close().await;

    let mut locked = sodoken::LockedArray::new(passphrase.len()).unwrap();
    locked.lock().copy_from_slice(&passphrase);
    let key = retrieve::load_database_key(tmp.path(), locked)
        .await
        .unwrap()
        .expect("db.key is present, so a key must be returned");

    let read = retrieve::open_dht_database(tmp.path(), &dna(), Some(&key))
        .await
        .expect("the encrypted database opens with the conductor's key");
    let rows = extensions::migration_status_by_author(&read).await.unwrap();

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].author, mover);
    assert!(rows[0].chain_closed);
}

// ---------------------------------------------------------------------------
// Integration, not just validity
// ---------------------------------------------------------------------------

/// A conductor stamps `record_validity = Accepted` on its *own* actions when it
/// flushes them, before any op integrates. Reading that column alone would
/// therefore count a node's own migration the instant it was committed. Every
/// "integrated" read must also require an integrated op.
#[tokio::test]
async fn a_self_authored_close_is_not_counted_until_its_op_integrates() {
    let tmp = tempfile::tempdir().unwrap();
    let db = new_dht_db(tmp.path(), None).await;
    let local = agent(0x77);

    let close = signed_action(0x01, &local, 1, 1_000, close_chain());
    insert_self_authored_uningtegrated(&db, &close).await;
    // Ordinary traffic from the same agent, also committed but not integrated.
    let create = signed_action(0x02, &local, 2, 1_000, create_data(0xa2));
    insert_self_authored_uningtegrated(&db, &create).await;
    let joined = signed_action(0x03, &local, 0, 1_000, agent_validation_pkg());
    insert_self_authored_uningtegrated(&db, &joined).await;

    let read = open_for_read(tmp.path()).await;

    assert!(
        extensions::migration_status_by_author(&read)
            .await
            .unwrap()
            .is_empty(),
        "a committed but un-integrated CloseChain is not a completed migration"
    );
    assert!(
        retrieve::count_actions_by_author(&read)
            .await
            .unwrap()
            .is_empty(),
        "un-integrated actions do not count towards agent activity"
    );
    assert!(
        retrieve::list_discovered_agents(&read)
            .await
            .unwrap()
            .is_empty(),
        "an un-integrated validation package is not a discovered agent"
    );
    assert!(
        retrieve::get_agent_chain(&read, &local)
            .await
            .unwrap()
            .is_empty(),
        "the chain read reports what integrated here, not what was merely committed"
    );

    // Integrating the close makes it — and only it — count.
    db.insert_chain_op(InsertChainOp {
        op_hash: &op_hash(0x81),
        action_hash: close.as_hash(),
        op_type: i64::from(ChainOpType::CreateRecord),
        basis_hash: &basis(0x81),
        storage_center_loc: 1,
        validation_status: RecordValidity::Accepted,
        locally_validated: true,
        require_receipt: false,
        when_received: Timestamp::from_micros(9_000),
        when_integrated: Timestamp::from_micros(10_000),
        serialized_size: 64,
    })
    .await
    .unwrap();

    let read = open_for_read(tmp.path()).await;
    let rows = extensions::migration_status_by_author(&read).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert!(rows[0].chain_closed);
    assert_eq!(
        retrieve::count_actions_by_author(&read).await.unwrap(),
        vec![(local, 1)]
    );
}

// ---------------------------------------------------------------------------
// Pending ops and blocks
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pending_ops_carry_their_action_and_entry() {
    let tmp = tempfile::tempdir().unwrap();
    let db = new_dht_db(tmp.path(), None).await;
    let author = agent(0x11);

    let entry = Entry::App(
        holochain_zome_types::prelude::AppEntryBytes::try_from(
            holochain_serialized_bytes::SerializedBytes::from(
                holochain_serialized_bytes::UnsafeBytes::from(vec![9, 8, 7]),
            ),
        )
        .unwrap(),
    );
    let entry_hash = EntryHash::from_raw_36(vec![0xa1; 36]);
    db.insert_entry(&entry_hash, &entry).await.unwrap();

    let action = signed_action(
        0x01,
        &author,
        1,
        4_242,
        ActionData::Create(CreateData {
            entry_type: EntryType::App(holochain_zome_types::prelude::AppEntryDef {
                entry_index: 0.into(),
                zome_index: 0.into(),
                visibility: EntryVisibility::Public,
            }),
            entry_hash: entry_hash.clone(),
        }),
    );
    insert_pending(&db, &action, 0x81).await;

    let read = open_for_read(tmp.path()).await;
    let pending = retrieve::get_pending_ops(&read).await.unwrap();

    assert_eq!(pending.len(), 1);
    let record = &pending[0];
    assert_eq!(record.dht_op.hash, op_hash(0x81));
    assert_eq!(record.dht_op.action_hash, *action.as_hash());
    assert_eq!(record.dht_op.typ, ChainOpType::CreateRecord);
    // The authoring time comes from the joined action, not the op.
    assert_eq!(record.dht_op.authored_timestamp, Timestamp(4_242));
    assert_eq!(record.action, action);
    assert_eq!(record.entry, Some(entry));
    assert!(record.dht_op.meta.require_receipt);
}

/// A limbo op is only labelled once its outcome is terminal: passing sys
/// validation leaves it queued for app validation, so it stays undecided.
#[tokio::test]
async fn pending_op_status_waits_for_a_terminal_outcome() {
    let tmp = tempfile::tempdir().unwrap();
    let db = new_dht_db(tmp.path(), None).await;
    let author = agent(0x11);

    let action = signed_action(0x01, &author, 1, 1_000, create_data(0xa1));
    insert_pending(&db, &action, 0x81).await;

    let read = open_for_read(tmp.path()).await;
    assert_eq!(
        retrieve::get_pending_ops(&read).await.unwrap()[0]
            .dht_op
            .validation_status,
        None,
        "an op that has not been validated at all is undecided"
    );

    db.set_limbo_chain_op_sys_validation_status(
        &op_hash(0x81),
        Some(i64::from(RecordValidity::Accepted)),
    )
    .await
    .unwrap();
    let read = open_for_read(tmp.path()).await;
    assert_eq!(
        retrieve::get_pending_ops(&read).await.unwrap()[0]
            .dht_op
            .validation_status,
        None,
        "passing sys validation alone must not read as fully valid"
    );

    db.set_limbo_chain_op_app_validation_status(
        &op_hash(0x81),
        Some(i64::from(RecordValidity::Accepted)),
    )
    .await
    .unwrap();
    let read = open_for_read(tmp.path()).await;
    assert_eq!(
        retrieve::get_pending_ops(&read).await.unwrap()[0]
            .dht_op
            .validation_status,
        Some(ValidationStatus::Valid),
        "once app validation concludes the outcome is terminal"
    );
}

#[tokio::test]
async fn blocks_round_trip_from_the_conductor_database() {
    let tmp = tempfile::tempdir().unwrap();
    let db = new_conductor_db(tmp.path()).await;

    let target = BlockTargetId::Ip("192.0.2.1".parse().unwrap());
    let reason = BlockTargetReason::Ip(IpBlockReason::DoS);
    sqlx::query(
        "INSERT INTO BlockSpan (target_id, target_reason, start_us, end_us) VALUES (?, ?, ?, ?)",
    )
    .bind(holochain_serialized_bytes::encode(&target).unwrap())
    .bind(holochain_serialized_bytes::encode(&reason).unwrap())
    .bind(1_000i64)
    .bind(2_000i64)
    .execute(db.pool())
    .await
    .unwrap();

    let read = retrieve::open_conductor_database(tmp.path(), None)
        .await
        .unwrap();
    let blocks = retrieve::get_blocks(&read).await.unwrap();

    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].target, target);
    assert_eq!(format!("{:?}", blocks[0].reason), format!("{reason:?}"));
    assert_eq!(blocks[0].start, Timestamp(1_000));
    assert_eq!(blocks[0].end, Timestamp(2_000));
}
