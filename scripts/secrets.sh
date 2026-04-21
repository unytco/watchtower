#!/usr/bin/env bash
#
# Interactively set Worker secrets: RESEND_API_KEY, ALERT_FROM_ADDRESS.
# Prompts are read silently where appropriate so values don't land in shell history.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "${SCRIPT_DIR}/_common.sh"

require_cmd pnpm

put_secret() {
  local name="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    warn "Skipping $name (empty)."
    return
  fi
  echo -n "$value" | wrangler_in "$WORKER_DIR" secret put "$name"
}

echo
read -r -s -p "RESEND_API_KEY (leave empty to skip): " RESEND_API_KEY
echo
read -r    -p "ALERT_FROM_ADDRESS (e.g. watchtower@unyt.dev, leave empty to skip): " ALERT_FROM_ADDRESS
echo

put_secret "RESEND_API_KEY"    "$RESEND_API_KEY"
put_secret "ALERT_FROM_ADDRESS" "$ALERT_FROM_ADDRESS"

log "Secrets applied."
