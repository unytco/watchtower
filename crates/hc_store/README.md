# unyt_watchtower_hc_store

Vendored data layer from [ThetaSinner/hc-ops](https://github.com/ThetaSinner/hc-ops).

## Vendor pin

- Source repo: `github.com/ThetaSinner/hc-ops`
- Vendored on: 2026-04-20
- Commit SHA: **pending** — update this file when re-vendoring
- Original crate version: `0.3.0`

Files copied as-is:

- `retrieve.rs` + `retrieve/{crypt,model,schema}.rs`
- `readable.rs`
- `ops.rs`

Re-vendored via: `cp hc-ops/src/{retrieve.rs,retrieve/*.rs,readable.rs,ops.rs} unyt-watchtower/crates/hc_store/src/` plus wiring in `lib.rs`.

Files added by unyt-watchtower:

- `extensions.rs` — validation coverage, chain locks, scheduled functions,
  nonce stats, integration-lag percentiles, cap-grant summaries.

## Why vendor instead of depend?

`hc-ops` is aimed at human-interactive debugging and its public API shifts
with Holochain releases. We want a stable internal surface and the freedom
to ship small patches without waiting for upstream.

When upstream adds a useful query, copy it into `extensions.rs` (or update
the vendored file and bump the SHA here). Keep changes minimal and
attributable.
