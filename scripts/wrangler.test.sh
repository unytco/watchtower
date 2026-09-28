#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "${SCRIPT_DIR}/_common.sh"

require_cmd pnpm

version_in() {
  local out
  if ! out="$(wrangler_in "$1" --version)"; then
    err "FAIL  wrangler does not run in ${1}: ${out}"
    exit 1
  fi
  echo "$out"
}

worker="$(version_in "$WORKER_DIR")"
dashboard="$(version_in "$DASHBOARD_DIR")"
if [[ "$dashboard" != "$worker" ]]; then
  err "FAIL  the dashboard runs wrangler ${dashboard}, the worker ${worker}."
  exit 1
fi
log "ok    the worker and the dashboard both run wrangler ${worker}"
