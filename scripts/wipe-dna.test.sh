#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "${SCRIPT_DIR}/_common.sh"

require_cmd pnpm
require_cmd jq

DNA_A="hC0k$(printf 'a%.0s' {1..48})"
DNA_B="hC0k$(printf 'b%.0s' {1..48})"
DNA_C="hC0k$(printf 'c%.0s' {1..48})"
ROWS_PER_DNA=6

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
persist="${scratch}/d1"
unmigrated="${scratch}/unmigrated"
shim_bin="${scratch}/bin"
mkdir "$persist" "$unmigrated" "$shim_bin"

d1() {
  wrangler_in "$WORKER_DIR" d1 execute watchtower --local --persist-to "$persist" "$@" >/dev/null
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
      VALUES ('bridge-${dna}', '${dna}', 't', 0, 'v', 't');"
}

rows_of() {
  local dna="$1"
  wrangler_in "$WORKER_DIR" d1 execute watchtower --local --persist-to "$persist" --json --command "SELECT
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

run_script() {
  rc=0
  out="$(bash "${SCRIPT_DIR}/wipe-dna.sh" "$@" 2>&1)" || rc=$?
}

wipe() {
  run_script --persist-to "$persist" "$@"
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
  wipe --yes "$@" </dev/null
  refused "$what" "$message"
}

rows_of_all() {
  echo "$(rows_of "$DNA_A") $(rows_of "$DNA_B") $(rows_of "$DNA_C")"
}

wrangler_in "$WORKER_DIR" d1 migrations apply watchtower --local --persist-to "$persist" >/dev/null
seed "$DNA_A"
seed "$DNA_B"
seed "$DNA_C"
all_seeded="$ROWS_PER_DNA $ROWS_PER_DNA $ROWS_PER_DNA"
check "seeded three DNAs" "$all_seeded" "$(rows_of_all)"

rejects "no DNA" "Missing DNA hash"
pad() { echo "$1${DNA_A:${#1}}"; }
rejects "a quote" "Not a DNA hash" "$(pad "hC0k' OR 1=1 OR '")"
rejects "SQL and sed syntax without a quote" "Not a DNA hash" "$(pad "hC0k/;s/WHERE /WHERE 1 OR /;#")"
rejects "an ampersand" "Not a DNA hash" "$(pad "hC0k&")"
rejects "a backslash" "Not a DNA hash" "$(pad "hC0k\\")"
rejects "one char short" "Not a DNA hash" "${DNA_A:0:51}"
LC_ALL=en_US.UTF-8 rejects "a non-ASCII letter" "Not a DNA hash" "${DNA_A:0:51}é"
rejects "an agent hash" "Not a DNA hash" "hCAk${DNA_A:4}"
rejects "two DNAs" "One DNA hash per run" "$DNA_A" "$DNA_B"
check "rejected runs deleted nothing" "$all_seeded" "$(rows_of_all)"

run_script --persist-to "$unmigrated" "$DNA_A" </dev/null
refused "a D1 without the schema" "Counting rows failed"

wipe "$DNA_A" <<<"no"
refused "answered no" "Not confirmed"
check "the prompt shows without a terminal" true "$(says "Type the DNA hash or 'yes'")"
wipe "$DNA_A" <<<"$DNA_B"
refused "answered with another DNA" "Not confirmed"
wipe "$DNA_A" </dev/null
refused "no answer" "Not confirmed"
check "unconfirmed runs deleted nothing" "$all_seeded" "$(rows_of_all)"

d1 --command "CREATE TRIGGER wipe_fails BEFORE DELETE ON warrants BEGIN SELECT RAISE(ABORT, 'refused'); END;"
wipe --yes "$DNA_C" </dev/null
d1 --command "DROP TRIGGER wipe_fails;"
refused "a failing delete" "The delete on"
check "a failing delete deleted nothing" "$ROWS_PER_DNA" "$(rows_of "$DNA_C")"

d1 --command "CREATE TRIGGER wipe_reposts AFTER DELETE ON dnas_seen WHEN OLD.observer_id = 'obs-1'
  BEGIN INSERT INTO dnas_seen VALUES ('obs-2', OLD.dna_b64, NULL, 't', 't', 't'); END;"
wipe --yes "$DNA_C" </dev/null
d1 --command "DROP TRIGGER wipe_reposts;"
refused "rows re-posted during the delete" "1 rows remain"
check "rows re-posted during the delete: only those remain" 1 "$(rows_of "$DNA_C")"

wipe "u${DNA_A}" <<<"$DNA_A"
check "confirmed by typing the DNA: exits zero" 0 "$rc"
for line in "alert_incidents 2" "warrant_sightings 1" "warrants 1" "dnas_seen 1" "bridge_services 1" "agents_discovered 0" "total ${ROWS_PER_DNA}"; do
  read -r table n <<<"$line"
  check "preview shows ${table} ${n}" true "$([[ "$out" =~ (^|$'\n')\ +${table}\ +${n}($'\n') ]] && echo true || echo false)"
done
check "recounted and found no rows left" true "$(says "No rows left")"
check "warns that live observers re-create rows" true "$(says "re-create")"
check "DNA A is gone, B untouched" "0 $ROWS_PER_DNA 1" "$(rows_of_all)"

wipe "$DNA_A" </dev/null
check "nothing left: exits zero" 0 "$rc"
check "nothing left: says so" true "$(says "Nothing to delete")"

wipe "$DNA_C" <<<"u${DNA_C}"
check "confirmed by typing the u form of a bare argument" "0 0" "$rc $(rows_of "$DNA_C")"
seed "$DNA_C"
wipe "$DNA_C" <<<"yes"
check "confirmed by typing yes" "0 0" "$rc $(rows_of "$DNA_C")"
seed "$DNA_C"
wipe --yes "$DNA_C" </dev/null
check "--yes skips the prompt" "0 0" "$rc $(rows_of "$DNA_C")"
check "DNA B survived every run" "$ROWS_PER_DNA" "$(rows_of "$DNA_B")"

n_tables="$(grep -c '^DELETE FROM' "${SCRIPT_DIR}/wipe-dna.sql")"
# The shim answers wrangler's nth call with the nth argument of `shim`, and logs each call.
cat >"${shim_bin}/pnpm" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$SHIM_LOG"
n="$(wc -l <"$SHIM_LOG")"
sed -n "${n}p" "$SHIM_REPLIES"
EOF
chmod +x "${shim_bin}/pnpm"
export SHIM_LOG="${scratch}/pnpm.log" SHIM_REPLIES="${scratch}/pnpm.replies"
shim() {
  local replies=()
  while [[ "$1" != -- ]]; do
    replies+=("$1")
    shift
  done
  shift
  printf '%s\n' "${replies[@]}" >"$SHIM_REPLIES"
  : >"$SHIM_LOG"
  rc=0
  out="$(PATH="${shim_bin}:$PATH" bash "${SCRIPT_DIR}/wipe-dna.sh" "$@" 2>&1 </dev/null)" || rc=$?
}
counts_of() {
  echo "[{\"results\":[{$(seq -s, -f "\"t%g\":$1" 1 "$n_tables")}],\"success\":true}]"
}
logged() {
  grep -q -- "$1" "$SHIM_LOG" && echo true || echo false
}

shim "$(counts_of 0)" -- "$DNA_A"
check "no flag targets remote" "true false remote" "$(logged --remote) $(logged --local) $(says "remote D1" | sed 's/true/remote/')"
shim "$(counts_of 0)" -- --local "$DNA_A"
check "--local targets local" "false true local" "$(logged --remote) $(logged --local) $(says "local D1" | sed 's/true/local/')"
shim '[{"results":[{"t1":5}],"success":true}]' -- --yes "$DNA_A"
refused "a count of the wrong width" "Counting rows failed"
check "a count of the wrong width: never deletes" false "$(logged --file)"
shim "$(counts_of 1 | sed 's/"t1":1/"t1":null/')" -- --yes "$DNA_A"
refused "a count that is not a number" "Counting rows failed"
check "a count that is not a number: never deletes" false "$(logged --file)"
shim "$(counts_of 1)" '[]' 'not json' -- --yes "$DNA_A"
refused "a failed recount" "recounting failed"
check "a failed recount: the delete ran" true "$(logged --file)"

make_n() {
  rc=0
  out="$(make -s -n -C "$REPO_ROOT" wipe-dna "$@" 2>&1)" || rc=$?
  out="$(tr -s ' ' <<<"$out" | sed 's/.*wipe-dna\.sh //')"
}
make_n DNA=x YES=1 LOCAL=1
check "make YES=1 LOCAL=1 passes --local --yes" "0 --local --yes \"\$DNA\"" "$rc $out"
make_n DNA=x YES=0 LOCAL=0
check "make YES=0 LOCAL=0 targets remote and prompts" "0 \"\$DNA\"" "$rc $out"
make_n DNA=x LOCAL=true
check "make LOCAL=true is refused" "2 true" "$rc $(says "LOCAL and YES take 0 or 1")"
for v in LOCAL YES; do
  rc=0
  out="$(env "${v}=1" make -s -n -C "$REPO_ROOT" wipe-dna DNA=x 2>&1)" || rc=$?
  check "make with ${v} only in the environment is refused" "2 true" "$rc $(says "Pass ${v} on the make command line")"
done
rc=0
out="$(DNA=x make -s -n -C "$REPO_ROOT" wipe-dna 2>&1)" || rc=$?
check "make with DNA only in the environment is refused" "2 true" "$rc $(says "DNA=<hash>")"

if ((failures)); then
  err "${failures} check(s) failed."
  exit 1
fi
log "All wipe-dna checks passed."
