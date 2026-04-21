#!/usr/bin/env bash
#
# Bootstrap the Cloudflare Pages project `unyt-watchtower-dashboard`.
#
# Wrangler 4.x has no CLI for Pages custom-domain binding, so this script
# creates the project (idempotent) and then:
#   - If CLOUDFLARE_API_TOKEN is set, binds watchtower.unyt.dev via the REST API.
#   - Otherwise, prints the exact dashboard URL to bind it manually.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "${SCRIPT_DIR}/_common.sh"

require_cmd jq
require_cmd pnpm
require_cmd curl

PROJECT="unyt-watchtower-dashboard"
DOMAIN="watchtower.unyt.dev"
# Must match the account_id in dashboard/wrangler.jsonc.
ACCOUNT_ID="$(jq -r '.account_id' "$DASHBOARD_DIR/wrangler.jsonc" 2>/dev/null || true)"
if [[ -z "$ACCOUNT_ID" || "$ACCOUNT_ID" == "null" ]]; then
  # jq chokes on // comments; fall back to a grep.
  ACCOUNT_ID="$(grep -Eo '"account_id"[[:space:]]*:[[:space:]]*"[^"]+"' "$DASHBOARD_DIR/wrangler.jsonc" \
    | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
fi

log "Ensuring Pages project '$PROJECT' exists..."
# `wrangler pages project list --json` is unreliable across wrangler versions
# (wrangler 4.x drops `--json`), so we run `create` and treat "already exists"
# (Cloudflare code 8000002) as success.
CREATE_LOG="$(mktemp)"
if wrangler_in "$DASHBOARD_DIR" pages project create "$PROJECT" \
  --production-branch main \
  --compatibility-date "$(date +%F)" >"$CREATE_LOG" 2>&1; then
  log "Pages project '$PROJECT' created."
  cat "$CREATE_LOG"
else
  if grep -Eqi 'already exists|8000002' "$CREATE_LOG"; then
    log "Pages project '$PROJECT' already exists."
  else
    err "Failed to create Pages project '$PROJECT':"
    cat "$CREATE_LOG" >&2
    rm -f "$CREATE_LOG"
    exit 1
  fi
fi
rm -f "$CREATE_LOG"

bind_via_api() {
  local token="$1"
  log "Binding custom domain $DOMAIN via Cloudflare API..."
  local url="https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/pages/projects/${PROJECT}/domains"
  local body http_code
  body="$(mktemp)"
  http_code="$(curl -sS -o "$body" -w '%{http_code}' \
    -X POST "$url" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    --data "{\"name\":\"$DOMAIN\"}")"
  case "$http_code" in
    200|201)
      log "Domain $DOMAIN bound."
      ;;
    409)
      log "Domain $DOMAIN already bound."
      ;;
    *)
      # Some accounts return 400 with "already exists" text.
      if grep -qi 'already' "$body"; then
        log "Domain $DOMAIN already bound."
      else
        warn "Cloudflare API returned $http_code:"
        cat "$body" >&2
        rm -f "$body"
        return 1
      fi
      ;;
  esac
  rm -f "$body"
}

if [[ -n "${CLOUDFLARE_API_TOKEN:-}" && -n "$ACCOUNT_ID" ]]; then
  bind_via_api "$CLOUDFLARE_API_TOKEN"
else
  warn "No CLOUDFLARE_API_TOKEN in env; skipping custom-domain binding."
  warn "Bind '$DOMAIN' manually once in the Cloudflare dashboard:"
  warn "  https://dash.cloudflare.com/${ACCOUNT_ID}/pages/view/${PROJECT}/domains"
  warn "  -> 'Set up a custom domain' -> '$DOMAIN'"
  warn "Re-run with CLOUDFLARE_API_TOKEN set (needs 'Pages:Edit' scope) to automate this."
fi

log "Pages bootstrap complete."
log "Cloudflare provisions the TLS certificate in the background (a few minutes)."
