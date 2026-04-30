# watchtower — Agent Instructions

## Purpose

Observability stack for the Unyt network: an **observer daemon**
(Rust) that watches a local Holochain conductor and emits structured
metrics, a **CLI** (Rust) for one-shot inspection, a **Cloudflare
Worker** (TS) that ingests + persists to D1, and a **dashboard**
(SvelteKit / Vite + Cloudflare Pages) that reads the worker's API.

## Classification

`service` — observer is deployed via `automation/`; worker + dashboard
deploy via Wrangler.

## License

`GPL-3.0-or-later` for the Rust workspace. This is forced by
the GPL-3.0 ancestry of [`crates/hc_store/`](crates/hc_store/)
(vendored from `ThetaSinner/hc-ops`) and applies to every binary
built from this workspace (observer daemon, CLI). New Rust code
must be GPL-3.0-compatible. See [Syncing `hc_store` from upstream
`hc-ops`](#syncing-hc_store-from-upstream-hc-ops) for the vendor
mechanics.

## Stack

- Rust workspace at root ([`Cargo.toml`](Cargo.toml),
  [`crates/`](crates/)): `observer`, `cli`, vendored `chain_doc` (sync
  target of [`hc-chain-doc`](../hc-chain-doc/)).
- Cloudflare Worker at [`worker/`](worker/) — `wrangler.jsonc`,
  TypeScript, D1-backed.
- Dashboard at [`dashboard/`](dashboard/) — SvelteKit + Vite, deploys
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
( cd dashboard && npx prettier --write "src/**/*.{ts,svelte,js,css,json}" )
( cd dashboard && npx prettier --check "src/**/*.{ts,svelte,js,css,json}" )
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

## Related repos in workshop

- Vendors [`hc-chain-doc`](../hc-chain-doc/) as
  [`crates/chain_doc/`](crates/chain_doc/) — keep them in sync.
- Vendors `ThetaSinner/hc-ops` (**GPL-3.0**, sibling on disk at
  [`../hc-ops/`](../hc-ops/), **untracked / read-only — we have no
  write access**) as
  [`crates/hc_store/src/{retrieve,ops,readable}.rs`](crates/hc_store/src/).
  This is what forces the workspace to GPL-3.0-or-later. See
  [Syncing `hc_store` from upstream `hc-ops`](#syncing-hc_store-from-upstream-hc-ops).
- Uses [`ham`](../ham/) for the observer's Holochain
  `AppWebsocket` connection.
- Deployed by [`automation/`](../automation/).

## Syncing `hc_store` from upstream `hc-ops`

[`crates/hc_store/`](crates/hc_store/) is a **read-only vendor** of
`ThetaSinner/hc-ops` (GPL-3.0). We have no write access to that
upstream — fixes for any data-layer bug must land watchtower-side
first, and may flow upstream later via a separately-coordinated PR
if/when ThetaSinner is open to it. The three vendored files
([`retrieve.rs`](crates/hc_store/src/retrieve.rs),
[`ops.rs`](crates/hc_store/src/ops.rs),
[`readable.rs`](crates/hc_store/src/readable.rs)) carry per-file
`Vendored from ThetaSinner/hc-ops @ <sha>` markers; those markers are
the source of truth for which upstream rev we're tracking. Watchtower-
specific additions live in
[`crates/hc_store/src/extensions.rs`](crates/hc_store/src/extensions.rs)
and as `retrieve::list_authored_identities` — these are NOT in
upstream, must be preserved on every sync, and should not bleed into
the verbatim files.

### When to sync

Sync only when motivated by a concrete need:

- A bug in upstream data parsing (op decoding, action decoding,
  SQLCipher key handling) that we hit and need a fix for.
- A new API in upstream we want to expose through watchtower.
- A Holochain dep bump on our side that requires upstream's adapter
  changes to compile.

Don't sync just to "stay current" — each sync is manual labor and
risks regressing watchtower-specific extensions.

### How to sync (5 steps)

1. `cd ../hc-ops && git fetch && git checkout <rev>` where
   `<rev>`'s `Cargo.toml` `holochain_*` / `kitsune2_*` /
   `holochain_serialized_bytes` versions match watchtower's
   [`[workspace.dependencies]`](Cargo.toml).
2. For each of `retrieve.rs`, `retrieve/`, `ops.rs`, `readable.rs`:
   diff `../hc-ops/src/<file>` against
   `watchtower/crates/hc_store/src/<file>`; adopt upstream changes.
   Preserve `list_authored_identities` (in `retrieve.rs`) and the
   entire [`crates/hc_store/src/extensions.rs`](crates/hc_store/src/extensions.rs)
   module — those are watchtower-specific additions, not in
   upstream.
3. Update the `Vendored from ThetaSinner/hc-ops @ <sha>` markers at
   the top of those files to the new rev, and bump the `Last sync:`
   line.
4. `nix develop -c cargo check --workspace`, then
   `nix develop -c cargo test --workspace`.
5. Commit with message `hc_store: sync to hc-ops <short-sha>`.

### When to migrate to a real Cargo dep

Defer the migration from vendoring to
`hc_ops = { git = "...", rev = "..." }` until **all three** of these
are true:

1. `hc-ops` upstream's `holochain_*` rc tags match watchtower's
   `[workspace.dependencies]`.
2. `hc-ops` drops the forked `serde_json`
   (`git = "https://github.com/ThetaSinner/json.git"`) — or we
   accept a `[patch.crates-io]` in watchtower's workspace pinning
   everyone to one fork.
3. `hc-ops` splits its `discover` default feature so a library
   consumer can `default-features = false` cleanly without losing
   the lib API.

Until then, vendor + sync is the path with the lowest blast radius.

## Changelog

File: [`./CHANGELOG.md`](./CHANGELOG.md). Format: [Keep a Changelog
1.1.0](https://keepachangelog.com/en/1.1.0/) with `## [Unreleased]`
at the top and standard subsections. One bullet per agent change,
≤120 chars, present-tense imperative. Branch-type → section mapping
per workshop
[`branch-and-pr-workflow.mdc`](../.cursor/rules/branch-and-pr-workflow.mdc).

Worker schema migrations (D1) and dashboard API contract changes
MUST appear under `### Changed` — operators redeploying need to read
them.

## Repo-specific rules

- **Observer must not panic on bad input.** Production data is
  hostile; classify and log unknown shapes, never crash the
  long-running daemon.
- **Vendored `chain_doc` is one-way.** Edit
  [`../hc-chain-doc/`](../hc-chain-doc/) first, then sync into
  [`crates/chain_doc/`](crates/chain_doc/). Never edit the vendor
  copy directly.
- **Vendored `hc_store` is GPL-3.0 upstream.** Sourced from
  `ThetaSinner/hc-ops` — we do not have write access. Sync
  watchtower-side only, preserving `list_authored_identities` and the
  entire [`extensions`](crates/hc_store/src/extensions.rs) module.
  This vendor is what makes the whole Rust workspace
  GPL-3.0-or-later; do not vendor additional GPL code without
  explicit review. Full procedure in [Syncing `hc_store` from upstream
  `hc-ops`](#syncing-hc_store-from-upstream-hc-ops).
- **Worker stays small.** Heavy compute belongs in the observer
  daemon (which has more memory and CPU); the worker should be a
  thin ingest + read API.

## Lessons learned

_Append entries here whenever an agent (or human) loses time to
something a guardrail would have prevented. Keep each entry: date,
short symptom, concrete fix._
