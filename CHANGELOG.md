# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- per-DNA migration counters: the observer derives two booleans per already-reported agent (`chain_closed` from a `CloseChain` action, `opening_summary_present` from an `OpenChain` action) by reading the DHT it already walks — no new scan — and each DNA's view shows "agents closed" / "agents opened" tiles plus the flags in the per-agent rows.

### Changed

- D1 migration `0004_migration_counters.sql`: `agents_discovered` gains `chain_closed` and `opening_summary_present` (INTEGER, default 0); the row stays keyed on `(observer, dna, agent)`, so the table remains bounded by fleet size. Apply on redeploy.
- dashboard API contract: `GET /api/dnas/:dna/summary` gains `agents_closed` / `agents_opened`; `GET /api/dnas/:dna/agents` rows gain `chain_closed` / `opening_summary_present`.
- upgrade Holochain ecosystem to 0.6.1 stable across all crates; kitsune2 to 0.4.1
