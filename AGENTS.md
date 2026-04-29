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
- Uses [`ham`](../ham/) for the observer's Holochain
  `AppWebsocket` connection.
- Deployed by [`automation/`](../automation/).

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
- **Worker stays small.** Heavy compute belongs in the observer
  daemon (which has more memory and CPU); the worker should be a
  thin ingest + read API.

## Lessons learned

_Append entries here whenever an agent (or human) loses time to
something a guardrail would have prevented. Keep each entry: date,
short symptom, concrete fix._
