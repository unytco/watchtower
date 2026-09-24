#!/usr/bin/env bash
#
# Drives scripts/wipe-dna.sh against a scratch local D1 carrying the real migrations.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "${SCRIPT_DIR}/_common.sh"

require_cmd pnpm
require_cmd jq

DNA_A="hC0k$(printf 'a%.0s' {1..48})"
DNA_B="hC0k$(printf 'b%.0s' {1..48})"
ROWS_PER_DNA=6

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
persist="${scratch}/d1"
unmigrated="${scratch}/unmigrated"
mkdir "$persist" "$unmigrated"

d1() {
  wrangler_in "$WORKER_DIR" d1 execute watchtower --local --persist-to "$persist" "$@"
}

seed() {
  local dna="$1"
  d1 --command "
    INSERT INTO warrants (observer_id, dna_b64, op_hash_b64, warrant_type, author_b64, target_b64, ts_iso, first_seen_at, updated_at)
      VALUES ('obs-1', '${dna}', 'op-${dna}', 'invalid', 'author', 'target', 't', 't', 't');
    INSERT INTO warrant_sightings (op_hash_b64, observer_id, last_seen_at) VALUES ('op-${dna}', 'obs-1', 't');
    INSERT INTO alert_incidents (id, rule_id, entity_key, fired_at, state)
      VALUES ('backlog-${dna}', 'rule', 'obs-1:${dna}:2026-09-24T10:00:00.000Z', 't', 'open');
    INSERT INTO alert_incidents (id, rule_id, entity_key, fired_at, state)
      VALUES ('warrant-${dna}', 'rule', 'op-${dna}', 't', 'open');
    INSERT INTO dnas_seen (observer_id, dna_b64, first_seen_iso, last_seen_iso, updated_at)
      VALUES ('obs-1', '${dna}', 't', 't', 't');
    INSERT INTO bridge_services (observer_id, dna_b64, last_seen_iso, uptime_s, binary_version, updated_at)
      VALUES ('bridge-${dna}', '${dna}', 't', 0, 'v', 't');" >/dev/null
}

rows_of() {
  local dna="$1"
  d1 --json --command "SELECT
      (SELECT COUNT(*) FROM warrants WHERE dna_b64 = '${dna}')
    + (SELECT COUNT(*) FROM warrant_sightings WHERE op_hash_b64 = 'op-${dna}')
    + (SELECT COUNT(*) FROM alert_incidents WHERE instr(entity_key, '${dna}') > 0)
    + (SELECT COUNT(*) FROM dnas_seen WHERE dna_b64 = '${dna}')
    + (SELECT COUNT(*) FROM bridge_services WHERE dna_b64 = '${dna}') AS n;" |
    jq '.[0].results[0].n'
}

failures=0
check() {
  local what="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    log "ok    ${what}"
  else
    err "FAIL  ${what}: expected '${expected}', got '${actual}'"
    failures=$((failures + 1))
  fi
}

# Runs wipe-dna.sh against the local D1 in $1, leaving its exit code in `rc` and output in `out`.
wipe_in() {
  local dir="$1"
  shift
  rc=0
  out="$(bash "${SCRIPT_DIR}/wipe-dna.sh" --persist-to "$dir" "$@" 2>&1)" || rc=$?
}

wipe() {
  wipe_in "$persist" "$@"
}

says() {
  [[ "$out" == *"$1"* ]] && echo true || echo false
}

refused() {
  local what="$1" message="$2"
  check "${what}: exits nonzero" 1 "$rc"
  check "${what}: says '${message}'" true "$(says "$message")"
}

rejects() {
  local what="$1" message="$2"
  shift 2
  wipe "$@" </dev/null
  refused "$what" "$message"
}

wrangler_in "$WORKER_DIR" d1 migrations apply watchtower --local --persist-to "$persist" >/dev/null
seed "$DNA_A"
seed "$DNA_B"
check "seeded DNA A" "$ROWS_PER_DNA" "$(rows_of "$DNA_A")"
check "seeded DNA B" "$ROWS_PER_DNA" "$(rows_of "$DNA_B")"

rejects "no DNA" "Missing DNA hash"
injection="hC0k' OR 1=1 OR '"
rejects "SQL in a DNA-length argument" "Not a DNA hash" "${injection}${DNA_A:${#injection}}"
rejects "one char short" "Not a DNA hash" "${DNA_A:0:51}"
rejects "non-ASCII char" "Not a DNA hash" "${DNA_A:0:51}é"
rejects "agent hash" "Not a DNA hash" "hCAk${DNA_A:4}"
rejects "two DNAs" "One DNA hash per run" "$DNA_A" "$DNA_B"
check "rejected runs deleted nothing" "$ROWS_PER_DNA $ROWS_PER_DNA" "$(rows_of "$DNA_A") $(rows_of "$DNA_B")"

wipe_in "$unmigrated" "$DNA_A" </dev/null
refused "D1 without the schema" "Counting rows failed"

wipe "$DNA_A" <<<"no"
refused "declined prompt" "Not confirmed"
wipe "$DNA_A" </dev/null
refused "no answer" "Not confirmed"
check "unconfirmed runs deleted nothing" "$ROWS_PER_DNA" "$(rows_of "$DNA_A")"

wipe "u${DNA_A}" <<<"$DNA_A"
check "confirmed with the typed DNA: exits zero" 0 "$rc"
check "preview counted DNA A's rows" true "$([[ "$out" =~ total[[:space:]]+${ROWS_PER_DNA} ]] && echo true || echo false)"
check "recounted and found no rows left" true "$(says "No rows left")"
check "warns that live observers re-create rows" true "$(says "re-create")"
check "DNA A is gone" 0 "$(rows_of "$DNA_A")"
check "DNA B is untouched" "$ROWS_PER_DNA" "$(rows_of "$DNA_B")"

wipe "$DNA_A" </dev/null
check "nothing left: exits zero" 0 "$rc"
check "nothing left: says so" true "$(says "Nothing to delete")"

wipe --yes "$DNA_B" </dev/null
check "--yes skips the prompt: exits zero" 0 "$rc"
check "--yes deleted DNA B" 0 "$(rows_of "$DNA_B")"

make_args() { make -s -n -C "$REPO_ROOT" wipe-dna "$@" | tr -s ' ' | sed 's/.*wipe-dna\.sh //'; }
check "make YES=1 LOCAL=1 passes --local --yes" "--local --yes \"\$DNA\"" "$(make_args YES=1 LOCAL=1)"
check "make YES=0 LOCAL=0 targets remote and prompts" "\"\$DNA\"" "$(make_args YES=0 LOCAL=0)"

if ((failures)); then
  err "${failures} check(s) failed."
  exit 1
fi
log "All wipe-dna checks passed."
