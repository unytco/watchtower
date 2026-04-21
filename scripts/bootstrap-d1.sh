#!/usr/bin/env bash
#
# Bootstrap the D1 database `watchtower`:
#   1. Skip if it already exists in the Cloudflare account.
#   2. Otherwise create it, extract the database_id, and patch
#      worker/wrangler.jsonc in place via jq.
#   3. Apply migrations from worker/migrations/ to the remote DB.
#
# Idempotent: safe to re-run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "${SCRIPT_DIR}/_common.sh"

require_cmd jq
require_cmd pnpm

WRANGLER_JSONC="${WORKER_DIR}/wrangler.jsonc"
if [[ ! -f "$WRANGLER_JSONC" ]]; then
  err "Not found: $WRANGLER_JSONC"
  exit 1
fi

log "Checking for existing D1 database 'watchtower'..."
EXISTING_JSON="$(wrangler_in "$WORKER_DIR" d1 list --json 2>/dev/null || echo '[]')"
EXISTING_ID="$(echo "$EXISTING_JSON" | jq -r '.[] | select(.name=="watchtower") | .uuid' | head -1)"

if [[ -n "$EXISTING_ID" ]]; then
  log "D1 'watchtower' already exists: $EXISTING_ID"
  DB_ID="$EXISTING_ID"
else
  log "Creating D1 'watchtower'..."
  CREATE_OUT="$(wrangler_in "$WORKER_DIR" d1 create watchtower)"
  echo "$CREATE_OUT"
  DB_ID="$(echo "$CREATE_OUT" | grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
  if [[ -z "$DB_ID" ]]; then
    err "Could not extract database_id from wrangler output"
    exit 1
  fi
  log "Created D1 database_id: $DB_ID"
fi

log "Patching worker/wrangler.jsonc with database_id..."
# jq preserves JSONC comments when given -c? No — jq strips comments.
# Use sed to keep the file format stable.
if grep -q '"database_id": "REPLACE_ME_LOCAL_DEV"' "$WRANGLER_JSONC"; then
  sed -i "s|\"database_id\": \"REPLACE_ME_LOCAL_DEV\"|\"database_id\": \"$DB_ID\"|" "$WRANGLER_JSONC"
  log "database_id written."
elif grep -q "\"database_id\": \"$DB_ID\"" "$WRANGLER_JSONC"; then
  log "database_id already correct in wrangler.jsonc."
else
  warn "wrangler.jsonc has a different database_id than $DB_ID; leaving alone."
fi

log "Applying D1 migrations (remote)..."
wrangler_in "$WORKER_DIR" d1 migrations apply watchtower --remote

log "D1 bootstrap complete."
