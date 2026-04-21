#!/usr/bin/env bash
#
# Deploy the Cloudflare Worker from ./worker.
# Assumes D1 has been bootstrapped (database_id present in wrangler.jsonc).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "${SCRIPT_DIR}/_common.sh"

require_cmd pnpm

if grep -q '"database_id": "REPLACE_ME_LOCAL_DEV"' "${WORKER_DIR}/wrangler.jsonc"; then
  err "wrangler.jsonc still has placeholder database_id."
  err "Run 'make bootstrap' (or scripts/bootstrap-d1.sh) first."
  exit 1
fi

log "Installing worker dependencies..."
(cd "$WORKER_DIR" && pnpm install --frozen-lockfile=false)

log "Deploying Worker..."
wrangler_in "$WORKER_DIR" deploy

log "Worker deploy complete."
