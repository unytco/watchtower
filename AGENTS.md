# watchtower — Agent Instructions

> **This repo follows the workshop root's patterns — it does not define its own.** Development workflow, process, changelog conventions, and spec/feature-doc discipline live in the workshop: [`CLAUDE.md`](../CLAUDE.md), [`AGENTS.md`](../AGENTS.md), [`documentation/DEVELOPMENT_WORKFLOW.md`](../documentation/DEVELOPMENT_WORKFLOW.md). Below is only what's specific to THIS repo.

## Purpose

`service` — observability stack for the Unyt network: an **observer
daemon** (Rust) that watches a local Holochain conductor and emits
structured metrics, a **CLI** (Rust) for one-shot inspection, a
**Cloudflare Worker** (TS) that ingests + persists to D1, and a
**dashboard** (React / Vite + Cloudflare Pages) that reads the
worker's API. Observer deploys via `automation/`; worker + dashboard
deploy via Wrangler.

## License

`GPL-3.0-or-later` for the Rust workspace, applying to every binary
built from it (observer daemon, CLI). New Rust code must be
GPL-3.0-compatible. The licence is inherited from
`ThetaSinner/hc-ops`, which [`crates/hc_store/`](crates/hc_store/) was
originally vendored from; the data layer has since been rewritten
against `holochain_data` (see [The `hc_store` data
layer](#the-hc_store-data-layer)), but
[`readable.rs`](crates/hc_store/src/readable.rs) still carries
hc-ops-derived code, so the obligation stands. **Whether the workspace
could be relicensed now is an open question — do not assume it can.**

## Stack

- Rust workspace at root ([`Cargo.toml`](Cargo.toml),
  [`crates/`](crates/)): `observer`, `cli`, vendored `chain_doc` (sync
  target of [`hc-chain-doc`](../hc-chain-doc/)).
- Cloudflare Worker at [`worker/`](worker/) — `wrangler.jsonc`,
  TypeScript, D1-backed.
- Dashboard at [`dashboard/`](dashboard/) — React + Vite, deploys
  to Cloudflare Pages via Wrangler.
- **Requires `nix develop -c …`** — see
  [`flake.nix`](flake.nix). The workshop's
  [Nix discipline section](../AGENTS.md#nix-discipline) lists this
  repo.

## Build

```bash
nix develop -c cargo build --release           # Rust workspace
( cd worker && npm install )                   # Worker deps
( cd dashboard && npm install )                # Dashboard deps
( cd dashboard && npm run build )              # Dashboard production build
```

The repo's [`Makefile`](Makefile) wraps common flows; see
`make help`.

## Format

Apply, then verify, per stack:

```bash
# Rust workspace
nix develop -c cargo fmt
nix develop -c cargo fmt --check

# Worker (no format script today; use prettier directly)
( cd worker && npx prettier --write "**/*.{ts,tsx,json}" )
( cd worker && npx prettier --check "**/*.{ts,tsx,json}" )

# Dashboard (no format script today; use prettier directly)
( cd dashboard && npx prettier --write "src/**/*.{ts,tsx,js,css,json}" )
( cd dashboard && npx prettier --check "src/**/*.{ts,tsx,js,css,json}" )
```

If a `format` / `format:check` script is later wired into either
`package.json`, prefer the script over `npx`.

## Test

```bash
nix develop -c cargo test                      # Rust workspace
( cd worker && npm test )                      # Worker tests
( cd dashboard && npm run typecheck )          # Type-only check
( cd dashboard && npm run test:e2e )           # Playwright e2e (if present)
```

## Deploy

- **Observer**: deployed by
  [`automation/scripts/setup-observer.sh`](../automation/scripts/) (or
  the relevant `make <server>` target — see workshop
  [Deployment hub](../AGENTS.md#deployment-hub-automation)).
- **Worker**: `( cd worker && npx wrangler deploy )` — production
  config in [`worker/wrangler.jsonc`](worker/wrangler.jsonc).
- **Dashboard**: `( cd dashboard && npx wrangler pages deploy dist )`
  after `npm run build`.

## The `hc_store` data layer

[`crates/hc_store/`](crates/hc_store/) reads a conductor's SQLite
databases directly — that is how the observer collects without
depending on admin-websocket coverage.

It was originally a vendored copy of `ThetaSinner/hc-ops`. Holochain
0.7 replaced the raw-SQL `holochain_sqlite` crate with the sqlx-based
`holochain_data` and reshaped the schema, so the vendored diesel layer
was rewritten and the vendor relationship ended: upstream targets 0.6
and there is nothing left to sync from. Only
[`readable.rs`](crates/hc_store/src/readable.rs) still derives from
hc-ops, and it no longer tracks it.

**Three facts must match the running conductor exactly, and all three
are taken from [`holochain_data`](https://docs.rs/holochain_data), the
crate the conductor writes with — never restated here:**

1. **The schema.** Row structs come from
   `holochain_data::models::dht`, and the tests build their fixtures
   with `holochain_data::open_db`, so the schema under test is the
   conductor's own embedded migration.
2. **The file names.** `holochain_data::kind::{Dht, Conductor}`
   produce `dht-<dna>.db` / `conductor.db`.
3. **The SQLCipher key derivation.** `holochain_data::DbKey` unlocks
   `<data_root>/databases/db.key` with the lair passphrase.

Enum discriminants are likewise bound from the Holochain enums
(`i64::from(ActionType::CloseChain)`), never written as literals.

### The rule this exists to enforce

A schema mismatch here **compiles fine and fails silently** — queries
return zero rows rather than erroring, so a broken observer looks like
a quiet network. Chasing the compiler to green proves nothing.

- Every read is covered by
  [`tests/real_schema.rs`](crates/hc_store/tests/real_schema.rs),
  which writes through `holochain_data`'s own API and reads back
  through `hc_store`. Never replace those fixtures with hand-written
  `CREATE TABLE` — that is precisely how the 0.7 break went unnoticed.
- On any Holochain bump, additionally cross-check the reads against a **real
  conductor**. The test that does this (`tests/real_schema.rs`) is `#[ignore]`d —
  run it with `cargo test --ignored` and `WT_REAL_ROOTS` set to conductor data
  roots (passphrase `passphrase`). A sweettest's own roots live in a `TempDir`
  that self-deletes when the test ends, so copy them out first or point at a
  standing conductor; then cross-check the counts against `holochain_data`'s own
  queries over the same file.

### Opening databases

Reads open the file read-write at the SQLite level but set
`PRAGMA query_only`, and leave `create_if_missing` off:

- read-write, because a `SQLITE_OPEN_READONLY` handle cannot replay a
  `-wal` left by a stopped conductor, which would make a switched-off
  node read as an empty one;
- `query_only`, so SQLite itself rejects any write;
- no create, so a wrong data root errors instead of conjuring an empty
  database that reports zero of everything.

`holochain_data::open_db` is deliberately **not** used for reading: it
creates the file if missing and runs migrations, neither of which
belongs anywhere near a production conductor.

## Repo-specific rules

- **Worker schema migrations (D1) and dashboard API contract changes
  MUST appear in `CHANGELOG.md` under `### Changed`** — operators
  redeploying need to read them.
- **Observer must not panic on bad input.** Production data is
  hostile; classify and log unknown shapes, never crash the
  long-running daemon.
- **Vendored `chain_doc` is one-way.** Edit
  [`../hc-chain-doc/`](../hc-chain-doc/) first, then sync into
  [`crates/chain_doc/`](crates/chain_doc/). Never edit the vendor
  copy directly.
- **`hc_store` must never restate Holochain's storage contract.**
  Schema, database file names, SQLCipher key derivation and enum
  discriminants all come from `holochain_data`; a copy of any of them
  breaks silently on the next Holochain bump. Full rationale in [The
  `hc_store` data layer](#the-hc_store-data-layer).
- **The workspace is GPL-3.0-or-later** through hc_store's hc-ops
  ancestry; do not vendor additional GPL code without explicit
  review.
- **Worker stays small.** Heavy compute belongs in the observer
  daemon (which has more memory and CPU); the worker should be a
  thin ingest + read API.
