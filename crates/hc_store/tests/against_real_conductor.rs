//! Reads checked against databases a **real conductor** wrote.
//!
//! [`real_schema`](../real_schema.rs) proves the queries against a database
//! built with `holochain_data`'s writer API. This goes one step further and
//! points them at data roots a running conductor produced, cross-checking every
//! count against `holochain_data`'s own queries over the same file. It is the
//! gate for a Holochain version bump: a hand-mapped query layer is never
//! checked against a live database by the compiler, so a schema change lands as
//! zero rows rather than an error.
//!
//! Ignored by default — it needs conductor data on disk. To run it:
//!
//! ```text
//! # 1. produce data roots (a sweettest conductor; add a migration test to
//! #    exercise the CloseChain / OpenChain counters), copying
//! #    <tmp>/holochain-test-environments*/databases/{db.key,dht-*.db*}
//! #    into <dir>/<node>/databases/ as they appear — the conductor's
//! #    TempDir deletes them when the test ends.
//! # 2. point this at the collected roots:
//! WT_REAL_ROOTS=<dir> nix develop -c \
//!     cargo test -p unyt_watchtower_hc_store --test against_real_conductor \
//!     -- --ignored --nocapture
//! ```
//!
//! The passphrase is `passphrase`, which is what `ConductorBuilder` uses when
//! none is configured. Against a production node, use that node's lair
//! passphrase instead.

use holochain_data::kind;
use holochain_data::{DatabaseIdentifier, HolochainDataConfig, open_db};
use std::sync::Arc;
use unyt_watchtower_hc_store::{extensions, retrieve};

#[tokio::test]
#[ignore = "needs real conductor data roots in WT_REAL_ROOTS; see the module docs"]
async fn reads_agree_with_holochain_data_on_real_databases() {
    let root = std::env::var("WT_REAL_ROOTS")
        .expect("set WT_REAL_ROOTS to a directory of conductor data roots; see the module docs");
    let passphrase = b"passphrase".to_vec();

    let mut nodes: Vec<_> = std::fs::read_dir(&root)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_dir())
        .collect();
    nodes.sort();

    let mut checked = 0usize;
    let mut total_actions = 0i64;
    for data_root in &nodes {
        let dnas = retrieve::list_dna_databases(data_root).unwrap();
        if dnas.is_empty() {
            println!("{}: no dht databases found", data_root.display());
            continue;
        }

        let mut locked = sodoken::LockedArray::new(passphrase.len()).unwrap();
        locked.lock().copy_from_slice(&passphrase);
        let key = retrieve::load_database_key(data_root, locked)
            .await
            .expect("load db.key")
            .expect("db.key present");

        for dna in &dnas {
            let db = retrieve::open_dht_database(data_root, dna, Some(&key))
                .await
                .expect("open real dht db");

            let integrated = extensions::count_integrated_ops(&db).await.unwrap();
            let pending = extensions::count_pending_ops(&db).await.unwrap();
            let counts = retrieve::count_actions_by_author(&db).await.unwrap();
            let agents = retrieve::list_discovered_agents(&db).await.unwrap();
            let migrations = extensions::migration_status_by_author(&db).await.unwrap();
            let warrants = retrieve::get_warrants(&db).await.unwrap();
            let pending_ops = retrieve::get_pending_ops(&db).await.unwrap();
            let slices = retrieve::get_slice_hashes(&db).await.unwrap();
            let locks = extensions::list_chain_locks(&db).await.unwrap();
            let sched = extensions::list_scheduled_functions(&db).await.unwrap();
            let grants = extensions::list_capability_grants(&db).await.unwrap();
            let coverage = extensions::validation_coverage_bottom_n(&db, 5)
                .await
                .unwrap();
            let lag = extensions::integration_lag(&db, 365 * 24 * 3600)
                .await
                .unwrap();

            // Every discovered agent's chain must decode end to end.
            let mut chain_len = 0usize;
            for a in &agents {
                let chain = retrieve::get_agent_chain(&db, a).await.unwrap();
                chain_len += chain.len();
            }

            // --- cross-check against holochain_data's own reads of the SAME file
            let hd = open_db(
                data_root.join("databases"),
                kind::Dht::new(Arc::new(dna.clone())),
                HolochainDataConfig::default().with_key(reload_key(data_root, &passphrase).await),
            )
            .await
            .expect("holochain_data opens the same file");
            let hd_read = hd.as_ref();
            let hd_integrated = hd_read.count_integrated_ops().await.unwrap() as i64;
            let (hd_val_limbo, hd_int_limbo, _) = hd_read.limbo_state_counts().await.unwrap();

            assert_eq!(
                integrated, hd_integrated,
                "{}: integrated op count disagrees with holochain_data",
                dna
            );
            assert_eq!(
                pending,
                hd_val_limbo + hd_int_limbo,
                "{}: pending op count disagrees with holochain_data's limbo totals",
                dna
            );

            for (agent, count) in &counts {
                // `get_actions_by_author` filters on `record_validity` alone,
                // which a conductor stamps on its own actions at commit time.
                // Our reads additionally require an integrated op, so we are a
                // subset — never a superset — and the two agree exactly once
                // the node has drained its limbo.
                let hd_chain = hd_read.get_actions_by_author(agent.clone()).await.unwrap();
                let ours = retrieve::get_agent_chain(&db, agent).await.unwrap();
                let ours_accepted: Vec<_> = ours
                    .iter()
                    .filter(|r| {
                        r.validation_status
                            == unyt_watchtower_hc_store::retrieve::ValidationStatus::Valid
                    })
                    .map(|r| r.action.clone())
                    .collect();

                assert_eq!(
                    *count,
                    ours_accepted.len() as i64,
                    "{}: the per-author count and the chain read disagree for {}",
                    dna,
                    agent
                );
                for action in &ours_accepted {
                    assert!(
                        hd_chain.contains(action),
                        "{}: we report an action holochain_data does not, for {}",
                        dna,
                        agent
                    );
                }
                if pending == 0 {
                    assert_eq!(
                        ours_accepted, hd_chain,
                        "{}: nothing is in limbo, so every committed action has integrated and the chains must match exactly, for {}",
                        dna, agent
                    );
                }
            }

            total_actions += counts.iter().map(|(_, c)| c).sum::<i64>();
            checked += 1;

            println!(
                "{} {}\n  file={} integrated={} pending={} agents={} authors={} chain_actions={}\n  migrations={} warrants={} pending_ops={} slices={} locks={} sched={} grants={} coverage={} lag(p50={}ms p99={}ms n={})",
                data_root.file_name().unwrap().to_string_lossy(),
                dna,
                kind::Dht::new(Arc::new(dna.clone())).database_id(),
                integrated,
                pending,
                agents.len(),
                counts.len(),
                chain_len,
                migrations.len(),
                warrants.len(),
                pending_ops.len(),
                slices.len(),
                locks.len(),
                sched.len(),
                grants.len(),
                coverage.len(),
                lag.p50_ms,
                lag.p99_ms,
                lag.sample_size,
            );
            for m in &migrations {
                println!(
                    "    migration author={} closed={} opened={}",
                    m.author, m.chain_closed, m.opening_summary_present
                );
            }

            db.close().await;
            hd.pool().close().await;
        }

        // Conductor database, where present.
        if data_root.join("databases").join("conductor.db").exists() {
            let mut locked = sodoken::LockedArray::new(passphrase.len()).unwrap();
            locked.lock().copy_from_slice(&passphrase);
            let key = retrieve::load_database_key(data_root, locked)
                .await
                .unwrap()
                .unwrap();
            let cdb = retrieve::open_conductor_database(data_root, Some(&key))
                .await
                .expect("open real conductor db");
            let nonce = extensions::nonce_stats(&cdb).await.unwrap();
            let blocks = retrieve::get_blocks(&cdb).await.unwrap();
            println!(
                "  conductor: nonces unique={} dup={} blocks={}",
                nonce.unique_count,
                nonce.duplicate_count,
                blocks.len()
            );
            cdb.close().await;
        }
    }

    println!("\nchecked {checked} real DHT databases, {total_actions} accepted actions total");
    assert!(checked > 0, "no real databases were checked");
    assert!(
        total_actions > 0,
        "every real database read as empty — that is the silent-failure mode this probe exists to catch"
    );
}

async fn reload_key(data_root: &std::path::Path, passphrase: &[u8]) -> holochain_data::DbKey {
    let locked = std::fs::read_to_string(data_root.join("databases").join("db.key")).unwrap();
    holochain_data::DbKey::load(
        locked.trim().to_string(),
        Arc::new(std::sync::Mutex::new(sodoken::LockedArray::from(
            passphrase.to_vec(),
        ))),
    )
    .await
    .unwrap()
}
