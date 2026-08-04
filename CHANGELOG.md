# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- per-DNA migration counters: the observer derives two booleans per already-reported agent (`chain_closed` from a `CloseChain` action, `opening_summary_present` from an `OpenChain` action) by reading the DHT it already walks — no new scan — and each DNA's view shows "agents closed" / "agents opened" tiles plus the flags in the per-agent rows.

### Changed

- upgrade Holochain to 0.7. `crates/hc_store` is rewritten off its vendored diesel schema onto `holochain_data` + sqlx: 0.7 replaced `holochain_sqlite` with `holochain_data` and reshaped the conductor's SQLite, so the hand-written schema was wrong in ways that compile clean and return zero rows. Reads now take the schema, the `dht-<dna>.db` / `conductor.db` file names, the SQLCipher key derivation and every enum discriminant from `holochain_data` itself. The data-layer API is now async; `collect_node_snapshot` and the `Exporter` methods follow.
- **dashboard API contract:** `WarrantSummary.proof_summary.chain_op_type` now carries Holochain 0.7's op-type names — `CreateRecord` / `CreateEntry` / `AgentActivity` / `UpdateEntry` / `UpdateRecord` / `DeleteEntry` / `DeleteRecord` / `CreateLink` / `DeleteLink`, replacing 0.6's `StoreRecord` / `StoreEntry` / `RegisterAgentActivity` / `Register*`. The field is a passthrough string, so no D1 migration is needed, but rows written before and after the upgrade carry different vocabularies.
- `lag_p50_ms` / `lag_p99_ms` are computed as `ChainOp.when_integrated − Action.timestamp` (0.7 moved the authoring timestamp onto the action), and the percentile now uses nearest rank. The old index under-reported the tail on small samples — with two samples it returned the *lower* lag as p99.
- `pending_ops_count` / `integrated_ops_count` are read from 0.7's split tables (`LimboChainOp` + `LimboWarrantOp`, `ChainOp` + `WarrantOp`) rather than a nullable `when_integrated`. Warrant ops stay counted, as they were when 0.6 held everything in one `DhtOp` table.
- the observer reports the number of reads it had to degrade in `SelfHealth.n_errors_this_cycle`, which was previously hard-coded to `0`. Each degraded read already logged; alerts fire off this field, so a node whose reads broke after a Holochain upgrade no longer shows green. A failed `migration_status_by_author` now drops its DNA from the snapshot rather than reporting every agent as un-migrated, and the Tier-2 warrants export records a per-DNA failure in the file instead of writing an empty array.
- pin Rust 1.95.0 (was 1.93.1): `sqlx` 0.9 requires ≥ 1.94, and 1.95 is what holonix `main-0.7` already provides.
- docs + example config follow the observer's move to the hash-explorer node (`make hash-explorer-watchtower` in automation replaces the always-online target; example `observer_id` is now `hash-explorer-1`). Deploy mechanics unchanged.
- D1 migration `0004_migration_counters.sql`: `agents_discovered` gains `chain_closed` and `opening_summary_present` (INTEGER, default 0); the row stays keyed on `(observer, dna, agent)`, so the table remains bounded by fleet size. Apply on redeploy.
- dashboard API contract: `GET /api/dnas/:dna/summary` gains `agents_closed` / `agents_opened`; `GET /api/dnas/:dna/agents` rows gain `chain_closed` / `opening_summary_present`.
- upgrade Holochain ecosystem to 0.6.2-rc.0 across all crates; kitsune2 stays at 0.4.1

### Removed

- the per-`(dna, agent)` authored databases and the per-DNA cache database, which 0.7 folded into the single `dht-<dna>.db` — chain locks, scheduled functions, cap grants and slice hashes are read from there now. `DbKind`, `open_holochain_database` and `list_authored_identities` are gone with them.
- `hc_store::ops` (the `AdminWebsocketExt` helpers) and the bulk `get_all_*` / slice readers, all inherited from hc-ops and called by nothing in this workspace.
