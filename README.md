# unyt-watchtower

Holochain observability for the Unyt network.

A self-reliant repo combining:

- `crates/observer` — `hc-watchtower-observer` daemon that runs on each Holochain node, reads the local SQLite state and admin websocket, and ships **small human-readable** snapshots to the Cloudflare Worker (no raw chains / op bodies leave the node).
- `crates/cli` — `hc-watchtower` operator CLI. Displays quick-view summaries and, on demand, writes **decoded bulk exports** to `/var/lib/hc-watchtower/exports/` for the operator to `scp` back.
- `crates/hc_store` — vendored `hc-ops` data layer (SQLite queries, SQLCipher key handling, admin-websocket extensions).
- `crates/chain_doc` — inlined `hc-chain-doc` (msgpack / link-tag decoding) used by CLI export commands.
- `crates/collector` — builds Tier-1 `NodeSnapshot` aggregates (counts, summaries, tags only — ≤100 KB/DNA).
- `crates/core` — shared DTOs (`NodeSnapshot`, `DnaSnapshot`, `ConductorSnapshot`, etc).
- `worker/` — Cloudflare Worker (Hono) + D1 schema. Latest-state upsert tables + small derived-metrics timeseries. HMAC + replay-protected ingest.
- `dashboard/` — Cloudflare Pages (Vite + React + Tailwind + shadcn) dashboard. Readability-first; no export buttons (exports are CLI-only).

Deployment scripts live in the `automation/` repo: see `automation/scripts/setup-watchtower-observer.sh` and `automation/config/{server}/watchtower.json`.

## Data layering

**Tier 1 (Cloudflare D1) — small, readable, latest-state only.**
Counts, quantities, summaries, tags, truncated hashes. Strictly ≤ 100 KB/DNA per collection. No chain bodies, no op blobs.

**Tier 2 (observer-local files) — bulk exports.**
Full chains, op bodies, record lookups, pending ops with bodies, full state dumps. Written by the CLI on the observer node to `/var/lib/hc-watchtower/exports/` as JSON files. Retrieve via `scp`. A janitor in the observer trims by age/size (configurable).

## Quick start (dev)

```bash
nix develop
cargo build
cd worker && pnpm install && pnpm wrangler dev &
cd dashboard && pnpm install && pnpm dev &
cd dashboard && pnpm seed      # push synthetic snapshots into the local Worker
```

## Layout

```
crates/
  core/          shared DTOs, size-budget helpers, hmac utils
  chain_doc/     msgpack/link-tag decoding (inlined hc-chain-doc)
  hc_store/      SQLite + admin-websocket data layer (vendored hc-ops)
  collector/     Tier-1 aggregation + on-demand file exports
  observer/      hc-watchtower-observer daemon
  cli/           hc-watchtower operator CLI
worker/          Cloudflare Worker (Hono) + D1 migrations
dashboard/       Cloudflare Pages (Vite + React + shadcn)
release/         binary release artifacts (populated by CI)
```

## License

Watchtower is licensed under [GPL-3.0-or-later](LICENSE) because it
vendors data-layer sources from
[ThetaSinner/hc-ops](https://github.com/ThetaSinner/hc-ops) (also
GPL-3.0) into [`crates/hc_store/`](crates/hc_store/). New
contributions to the Rust workspace must be GPL-3.0-compatible.

The TypeScript `worker/` and `dashboard/` subprojects communicate
with the observer over HTTP and do not link the GPL Rust code; they
are not subject to GPL by virtue of that boundary, and may be
licensed independently in their own `package.json`.
