#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "${SCRIPT_DIR}/_common.sh"
# shellcheck source=_test.sh
. "${SCRIPT_DIR}/_test.sh"

require_cmd jq
REAL_WRANGLER="${WORKER_DIR}/node_modules/.bin/wrangler"
if [[ ! -x "$REAL_WRANGLER" ]]; then
  err "Missing ${REAL_WRANGLER}: run make install first."
  exit 1
fi

GUARDED=0008_cap_grants_keyed_by_action.sql
UNGUARDED=0007_ingest_nonces_without_rowid.sql
PROMPT="Type 'yes' to accept them and apply the pending migrations"
LISTED_ONLY=$'install --frozen-lockfile=false\nexec wrangler d1 migrations list watchtower --remote'

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

# The scripts under test run from a copy of scripts/ and the worker's config and migrations, so a
# case can add a migration of its own without touching the tree.
copy="${scratch}/repo"
migrations="${copy}/worker/migrations"
mkdir -p "${copy}/worker"
cp -R "$SCRIPT_DIR" "${copy}/scripts"
cp -R "${WORKER_DIR}/migrations" "${WORKER_DIR}/wrangler.jsonc" "${copy}/worker/"

# The pnpm shim logs each call, runs `d1 migrations` against the local D1 in $SHIM_PERSIST in place
# of the remote one, answers `d1 list` with $SHIM_D1_LIST, and runs nothing else. The wrangler and
# npx shims refuse, so a call that bypasses pnpm fails instead of reaching Cloudflare.
shim_bin="${scratch}/bin"
mkdir "$shim_bin"
cat >"${shim_bin}/pnpm" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$SHIM_LOG"
case "$1 $2 $3 $4 $5" in
  "exec wrangler d1 list "*)
    printf '%s\n' "$SHIM_D1_LIST"
    exit 0
    ;;
  "exec wrangler d1 migrations list")
    if [[ "$(grep -c ' d1 migrations list ' "$SHIM_LOG")" == "${SHIM_FAIL_LIST_CALL:-}" ]]; then
      echo "✘ [ERROR] Authentication error" >&2
      exit 1
    fi
    if [[ -n "${SHIM_LIST:-}" ]]; then
      printf '%s\n' "$SHIM_LIST"
      exit 0
    fi
    ;;
  "exec wrangler d1 migrations apply")
    if [[ -n "${SHIM_SKIP_APPLY:-}" ]]; then
      exit 0
    fi
    if [[ -n "${SHIM_FAIL_APPLY:-}" ]]; then
      echo "✘ [ERROR] A statement failed" >&2
      exit 1
    fi
    ;;
  *) exit 0 ;;
esac
shift 2
args=()
for arg in "$@"; do
  if [[ "$arg" == --remote ]]; then
    args+=(--local --persist-to "$SHIM_PERSIST")
  else
    args+=("$arg")
  fi
done
if [[ "${args[*]}" == "$*" ]]; then
  echo "shim: expected --remote in: $*" >&2
  exit 1
fi
exec "$REAL_WRANGLER" "${args[@]}"
EOF
cat >"${shim_bin}/wrangler" <<'EOF'
#!/usr/bin/env bash
echo "escaped the pnpm shim: ${0##*/} $*" | tee -a "$SHIM_LOG" >&2
exit 1
EOF
cp "${shim_bin}/wrangler" "${shim_bin}/npx"
chmod +x "${shim_bin}"/*
DB_ID="$(sed -nE 's/.*"database_id": "([^"]+)".*/\1/p' "${WORKER_DIR}/wrangler.jsonc")"
SHIM_D1_LIST="$(printf '[{"name":"watchtower","uuid":"%s"}]' "$DB_ID")"
export SHIM_LOG="${scratch}/pnpm.log" SHIM_PERSIST="${scratch}/d1" SHIM_D1_LIST REAL_WRANGLER
mkdir "$SHIM_PERSIST"

local_wrangler() {
  (cd "${copy}/worker" && "$REAL_WRANGLER" "$@" --local --persist-to "$SHIM_PERSIST")
}
make_pending() {
  local name
  for name in "$@"; do
    local_wrangler d1 execute watchtower --command "DELETE FROM d1_migrations WHERE name = '${name}';" >/dev/null
  done
}
applied() {
  local_wrangler d1 execute watchtower --json --command "SELECT COUNT(*) AS n FROM d1_migrations WHERE name = '$1';" |
    jq -r '.[0].results[0].n == 1'
}
fixture() {
  local name="$1"
  shift
  printf '%s\n' "$@" >"${migrations}/${name}"
}

capture() {
  : >"$SHIM_LOG"
  rc=0
  out="$(PATH="${shim_bin}:$PATH" "$@" 2>&1)" || rc=$?
}
run() {
  local script="$1"
  shift
  capture bash "${copy}/scripts/${script}" "$@"
}
deploy() {
  run deploy-worker.sh "$@"
}
bootstrap() {
  run bootstrap-d1.sh "$@"
}
steps() {
  sed -nE 's/^exec wrangler (d1 migrations (list|apply)|(deploy))( .*)?$/\2\3/p' "$SHIM_LOG" | paste -sd' ' -
}
calls() {
  cat "$SHIM_LOG"
}
shows_preconditions() {
  local what="$1" file="$2" line
  check "${what}: names ${file}" true "$(says "  ${file}")"
  while IFS= read -r line; do
    check "${what}: shows '${line:0:40}...'" true "$(says "    ${line}")"
  done < <(sed -n 's/^-- precondition: //p' "${migrations}/${file}")
}

check "0008 declares preconditions" true "$(grep -q '^-- precondition: ' "${migrations}/${GUARDED}" && echo true || echo false)"
check "wrangler outside the pnpm shim is refused" 1 "$(PATH="${shim_bin}:$PATH" wrangler whoami >/dev/null 2>&1 || echo $?)"

local_wrangler d1 migrations apply watchtower >/dev/null

make_pending "$GUARDED" "$UNGUARDED"
deploy </dev/null
refused "a pending precondition, no answer" "Not confirmed. Nothing applied or deployed."
check "a pending precondition, no answer: prompts" true "$(says "$PROMPT")"
shows_preconditions "a pending precondition, no answer" "$GUARDED"
check "a migration without a precondition is not named" false "$(says "$UNGUARDED")"
check "a pending precondition, no answer: only installs and lists" "$LISTED_ONLY" "$(calls)"
check "a pending precondition, no answer: nothing applied" "false false" "$(applied "$GUARDED") $(applied "$UNGUARDED")"

: >"$SHIM_LOG"
rc=0
out="$(PATH="${shim_bin}:$PATH" bash "${copy}/scripts/deploy-worker.sh" 2>&1 >/dev/null </dev/null)" || rc=$?
check "stdout sent elsewhere: still prompts" true "$(says "$PROMPT")"
shows_preconditions "stdout sent elsewhere" "$GUARDED"

for answer in no y YES; do
  deploy <<<"$answer"
  refused "a pending precondition, answered ${answer}" "Not confirmed"
  check "a pending precondition, answered ${answer}: only installs and lists" "$LISTED_ONLY" "$(calls)"
done

deploy <<<"yes"
check "a pending precondition, answered yes: exits zero" 0 "$rc"
check "a pending precondition, answered yes: applies, then deploys" "list apply list deploy" "$(steps)"
check "a pending precondition, answered yes: both applied" "true true" "$(applied "$GUARDED") $(applied "$UNGUARDED")"

make_pending "$GUARDED"
deploy --yes </dev/null
check "--yes: exits zero" 0 "$rc"
shows_preconditions "--yes" "$GUARDED"
check "--yes: says so" true "$(says "Accepted by --yes.")"
check "--yes: does not prompt" false "$(says "$PROMPT")"
check "--yes: applies, then deploys" "list apply list deploy" "$(steps)"
check "--yes: applied" true "$(applied "$GUARDED")"

make_pending "$GUARDED"
WRANGLER_LOG=error deploy --yes </dev/null
check "WRANGLER_LOG=error in the environment: still reads the list" "0 true" "$rc $(applied "$GUARDED")"
shows_preconditions "WRANGLER_LOG=error in the environment" "$GUARDED"

make_pending "$GUARDED"
FORCE_COLOR=1 deploy --yes </dev/null
check "FORCE_COLOR=1 in the environment: still reads the list" "0 true" "$rc $(applied "$GUARDED")"
shows_preconditions "FORCE_COLOR=1 in the environment" "$GUARDED"

SECOND=0100_fixture_guarded.sql
fixture "$SECOND" "-- precondition: The first fixture condition holds." "-- precondition: The second fixture condition holds." \
  "CREATE TABLE IF NOT EXISTS fixture_guarded (x INTEGER);"
make_pending "$GUARDED"
deploy </dev/null
refused "two pending preconditions, no answer" "Not confirmed"
shows_preconditions "two pending preconditions" "$GUARDED"
shows_preconditions "two pending preconditions" "$SECOND"
check "two pending preconditions, no answer: only installs and lists" "$LISTED_ONLY" "$(calls)"
deploy --yes </dev/null
check "two pending preconditions, --yes: both applied" "0 true true" "$rc $(applied "$GUARDED") $(applied "$SECOND")"
rm "${migrations}/${SECOND}"

UNREAD=0101_fixture_unread.sql
fixture "$UNREAD" "-- Precondition: Written with a capital P." "CREATE TABLE IF NOT EXISTS fixture_unread (x INTEGER);"
deploy --yes </dev/null
refused "a precondition in another form" "${UNREAD} mentions a precondition in a form this cannot read"
check "a precondition in another form: shows the line" true "$(says "-- Precondition: Written with a capital P.")"
check "a precondition in another form: only installs and lists" "$LISTED_ONLY" "$(calls)"
check "a precondition in another form: not applied" false "$(applied "$UNREAD")"
rm "${migrations}/${UNREAD}"

make_pending "$UNGUARDED"
deploy </dev/null
check "pending without a precondition: exits zero" 0 "$rc"
check "pending without a precondition: does not prompt" false "$(says "$PROMPT")"
check "pending without a precondition: applies, then deploys" "list apply list deploy" "$(steps)"
check "pending without a precondition: applied" true "$(applied "$UNGUARDED")"

deploy </dev/null
check "nothing pending: exits zero" 0 "$rc"
check "nothing pending: shows no precondition" false "$(says "declare preconditions")"
check "nothing pending: applies, then deploys" "list apply list deploy" "$(steps)"

make_pending "$UNGUARDED"
SHIM_SKIP_APPLY=1 deploy </dev/null
refused "an apply that leaves a migration pending" "still pending after the apply: ${UNGUARDED}. The Worker was not deployed."
check "an apply that leaves a migration pending: never deploys" "list apply list" "$(steps)"
SHIM_FAIL_APPLY=1 deploy </dev/null
refused "a failed apply" "Applying the migrations failed. The Worker was not deployed."
check "a failed apply: never deploys" "list apply" "$(steps)"
SHIM_FAIL_LIST_CALL=2 deploy </dev/null
refused "a failed list after the apply" "Listing the migrations pending on the remote D1 failed. The Worker was not deployed."
check "a failed list after the apply: never deploys" "list apply list" "$(steps)"
make_pending "$UNGUARDED"
deploy </dev/null
check "the next deploy applies it" "0 true" "$rc $(applied "$UNGUARDED")"

deploy --force </dev/null
refused "an unknown argument" "Unknown argument: --force"
check "an unknown argument: runs nothing" "" "$(calls)"

SHIM_FAIL_LIST_CALL=1 deploy --yes </dev/null
refused "a failed list" "Listing the migrations pending on the remote D1 failed. Nothing applied or deployed."
check "a failed list: points at make login" true "$(says "run make login")"
check "a failed list: only installs and lists" "$LISTED_ONLY" "$(calls)"

table() {
  printf '%s\n' "Migrations to be applied:" "┌──────┐"
  printf '│ %s │\n' "$@"
  printf '%s\n' "└──────┘"
}
unreadable_list() {
  local what="$1"
  refused "$what" "Could not read which migrations are pending"
  check "${what}: only installs and lists" "$LISTED_ONLY" "$(calls)"
}
SHIM_LIST="Some future wrangler output" deploy --yes </dev/null
unreadable_list "a list wrangler words differently"
SHIM_LIST="$(table Name 0008-renamed.sql)" deploy --yes </dev/null
unreadable_list "a row naming no migration file"
SHIM_LIST="$(table Name "$UNGUARDED" "0008_cap_grants_keyed_by_act…")" deploy --yes </dev/null
unreadable_list "a truncated row beside a readable one"
SHIM_LIST="$(table "$UNGUARDED")" deploy --yes </dev/null
unreadable_list "a table without its Name header"
SHIM_LIST="$(table Name)" deploy --yes </dev/null
unreadable_list "a table with no rows"
SHIM_LIST="✅ No migrations to apply!"$'\n'"│ Name │"$'\n'"│ ${GUARDED} │" deploy --yes </dev/null
unreadable_list "a list both empty and naming a file"
SHIM_LIST="$(table Name "$GUARDED")" deploy </dev/null
refused "a readable hand-written table" "Not confirmed"

make_pending "$GUARDED"
bootstrap </dev/null
refused "bootstrap-d1, a pending precondition, no answer" "Not confirmed. Nothing applied or deployed."
shows_preconditions "bootstrap-d1, no answer" "$GUARDED"
check "bootstrap-d1, a pending precondition, no answer: only finds the D1 and lists" \
  $'exec wrangler d1 list --json\nexec wrangler d1 migrations list watchtower --remote' "$(calls)"
check "bootstrap-d1, a pending precondition, no answer: nothing applied" false "$(applied "$GUARDED")"
bootstrap --yes </dev/null
check "bootstrap-d1 --yes: exits zero" 0 "$rc"
check "bootstrap-d1 --yes: applies, rechecks, never deploys" "list apply list" "$(steps)"
check "bootstrap-d1 --yes: applied" true "$(applied "$GUARDED")"
check "bootstrap-d1 leaves wrangler.jsonc as it was" true "$(cmp -s "${WORKER_DIR}/wrangler.jsonc" "${copy}/worker/wrangler.jsonc" && echo true || echo false)"
bootstrap </dev/null
check "bootstrap-d1, nothing pending: exits zero" 0 "$rc"
check "bootstrap-d1, nothing pending: does not prompt" false "$(says "$PROMPT")"
make_pending "$UNGUARDED"
SHIM_SKIP_APPLY=1 bootstrap </dev/null
refused "bootstrap-d1, an apply that leaves a migration pending" "still pending after the apply: ${UNGUARDED}. The D1 bootstrap is not complete."
check "bootstrap-d1, an apply that leaves a migration pending: never says complete" false "$(says "D1 bootstrap complete.")"
bootstrap </dev/null
check "bootstrap-d1, the next run applies it" "0 true" "$rc $(applied "$UNGUARDED")"
bootstrap --force </dev/null
refused "bootstrap-d1, an unknown argument" "Unknown argument: --force"

cp "${REPO_ROOT}/Makefile" "${copy}/"
cat >"${copy}/scripts/deploy-dashboard.sh" <<'EOF'
echo deploy-dashboard >>"$SHIM_LOG"
EOF
make_pending "$GUARDED"
for flag in -k -j2; do
  capture make -s -C "$copy" "$flag" deploy </dev/null
  check "make ${flag} deploy after a refusal: fails and never deploys the dashboard" "2 true false" "$rc $(says "Not confirmed") $(logged deploy-dashboard)"
done
capture make -s -C "$copy" deploy YES=1 </dev/null
check "make deploy YES=1: the dashboard deploys after the Worker" "0 exec wrangler deploy|deploy-dashboard" "$rc $(tail -2 "$SHIM_LOG" | paste -sd'|' -)"
capture make -s -C "$scratch" -f "${copy}/Makefile" deploy </dev/null
check "make -f from another directory: deploys the dashboard" "0 true" "$rc $(logged deploy-dashboard)"

make_n bootstrap-d1 YES=1
check "make bootstrap-d1 YES=1 passes --yes" "0 bootstrap-d1.sh --yes" "$rc $out"
make_n bootstrap YES=1
check "make bootstrap YES=1 passes --yes to bootstrap-d1" "0 bootstrap-d1.sh --yes" "$rc $(head -1 <<<"$out")"
make_n bootstrap-d1
check "make bootstrap-d1 prompts" "0 bootstrap-d1.sh" "$rc $out"
make_n deploy-worker YES=1
check "make deploy-worker YES=1 passes --yes" "0 deploy-worker.sh --yes" "$rc $out"
make_n deploy-worker YES=0
check "make deploy-worker YES=0 prompts" "0 deploy-worker.sh" "$rc $out"
make_n deploy-worker
check "make deploy-worker prompts" "0 deploy-worker.sh" "$rc $out"
make_n deploy YES=1
check "make deploy YES=1 passes --yes to deploy-worker" "0 deploy-worker.sh --yes" "$rc $(head -1 <<<"$out")"
make_n deploy-worker YES=true
check "make deploy-worker YES=true is refused" "2 true" "$rc $(says "YES takes 0 or 1")"
make_n deploy-worker "YES=0 1"
check "make deploy-worker YES='0 1' is refused" "2 true" "$rc $(says "YES takes 0 or 1")"
rc=0
out="$(env YES=1 make -s -n -C "$REPO_ROOT" deploy-worker 2>&1)" || rc=$?
check "make deploy-worker with YES only in the environment is refused" "2 true" "$rc $(says "Pass YES on the make command line")"

finish migration-preconditions
