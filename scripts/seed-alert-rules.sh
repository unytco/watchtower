#!/usr/bin/env bash
#
# Idempotently provision the default set of alert rules against a running
# watchtower worker. Re-running is safe: each rule is keyed by (kind, recipient)
# and skipped if an enabled row already matches.
#
# Usage:
#   WORKER_URL=https://watchtower.unyt.dev RECIPIENT=you@example.com \
#     bash scripts/seed-alert-rules.sh
#
# Notes:
#   - Rules + incidents are written to D1 by the worker regardless of email
#     delivery. To actually receive mail, set RESEND_API_KEY and
#     ALERT_FROM_ADDRESS via `make secrets`.
#   - `chain_lock_expired` is provisioned but will stay quiet until the
#     observer's chain_locks collector is fixed (known bug: `expires_at`
#     column mismatch vs. current Holochain authored DB schema).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "${SCRIPT_DIR}/_common.sh"

require_cmd curl
require_cmd jq

WORKER_URL="${WORKER_URL:-https://watchtower.unyt.dev}"
RECIPIENT="${RECIPIENT:-joel.ulahanna@holo.host}"

log "Target worker: ${WORKER_URL}"
log "Recipient:     ${RECIPIENT}"

# Fail fast if the worker isn't reachable.
if ! curl -fsS -m 10 "${WORKER_URL}/healthz" >/dev/null; then
  err "Worker ${WORKER_URL}/healthz is not reachable. Is it deployed?"
  exit 1
fi

# Desired rules as a compact JSON array. Keep in sync with
# AlertRule["kind"] in watchtower/worker/src/alerts.ts.
DESIRED_JSON=$(cat <<JSON
[
  { "kind": "new_warrant",        "params": {} },
  { "kind": "observer_silent",    "params": { "max_silent_minutes": 15 } },
  { "kind": "pending_backlog",    "params": { "threshold": 2500 } },
  { "kind": "chain_lock_expired", "params": {} }
]
JSON
)

# Fetch existing rules once. Response shape: { rules: [{ id, kind, params_json,
# recipients_json, enabled, created_at }, ...] }.
EXISTING_JSON=$(curl -fsS -m 10 "${WORKER_URL}/api/alerts/rules")

# Build a lookup of (kind|recipient) for enabled rules.
# Each recipients_json is a JSON-encoded string array; flatten per recipient.
EXISTING_KEYS=$(echo "$EXISTING_JSON" | jq -r '
  .rules // []
  | map(select(.enabled == 1))
  | map(
      (.recipients_json | fromjson) as $rs
      | ($rs // []) | map("\(.)")
      | map("\(.) " + (.|tostring))
    )
  | .
' 2>/dev/null || true)

# Simpler + more robust: recompute EXISTING_KEYS as "kind|recipient" pairs.
EXISTING_KEYS=$(echo "$EXISTING_JSON" | jq -r '
  .rules // []
  | map(select(.enabled == 1))
  | map(
      . as $r
      | ($r.recipients_json | fromjson) as $rs
      | $rs[] | "\($r.kind)|\(.)"
    )
  | .[]
')

created=0
skipped=0

while IFS= read -r rule; do
  kind=$(echo "$rule" | jq -r '.kind')
  params=$(echo "$rule" | jq -c '.params')
  key="${kind}|${RECIPIENT}"

  if grep -Fxq "$key" <<<"$EXISTING_KEYS"; then
    log "skip  ${kind} (already provisioned for ${RECIPIENT})"
    skipped=$((skipped + 1))
    continue
  fi

  body=$(jq -nc \
    --arg kind "$kind" \
    --arg recipient "$RECIPIENT" \
    --argjson params "$params" \
    '{kind: $kind, params: $params, recipients: [$recipient], enabled: true}')

  resp=$(curl -fsS -m 10 -X POST "${WORKER_URL}/api/alerts/rules" \
    -H "content-type: application/json" \
    -d "$body")
  id=$(echo "$resp" | jq -r '.id // empty')

  if [[ -z "$id" ]]; then
    err "Unexpected response creating rule ${kind}: ${resp}"
    exit 1
  fi

  log "create ${kind} id=${id}"
  created=$((created + 1))
done < <(echo "$DESIRED_JSON" | jq -c '.[]')

log "Done. created=${created} skipped=${skipped}"

# Heads-up if email secrets are probably missing. We don't fail on this.
if command -v pnpm >/dev/null 2>&1; then
  if ! (cd "$WORKER_DIR" && pnpm exec wrangler secret list 2>/dev/null) \
        | grep -q '"RESEND_API_KEY"'; then
    warn "RESEND_API_KEY not found on the worker — incidents will be recorded"
    warn "but no email will go out. Run \`make secrets\` to set it."
  fi
fi
