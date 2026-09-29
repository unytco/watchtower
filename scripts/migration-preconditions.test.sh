#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "${SCRIPT_DIR}/_common.sh"
# shellcheck source=_test.sh
. "${SCRIPT_DIR}/_test.sh"

require_cmd pnpm
require_cmd jq

GUARDED=0008_cap_grants_keyed_by_action.sql
UNGUARDED=0007_ingest_nonces_without_rowid.sql
PROMPT="Type 'yes' to confirm it holds and apply the pending migrations"
FIRST_PRECONDITION="$(sed -nE '1,/precondition:/s/^-- precondition: //p' "${WORKER_DIR}/migrations/${GUARDED}")"

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
shim_bin="${scratch}/bin"
mkdir "$shim_bin"

# The shim stands in for pnpm: it logs each call, points `d1 migrations` at the local D1 in
# $SHIM_PERSIST in place of the remote one, and runs nothing else, so nothing is ever deployed.
cat >"${shim_bin}/pnpm" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$SHIM_LOG"
if [[ "$1 $2 $3 $4" != "exec wrangler d1 migrations" ]]; then
  exit 0
fi
if [[ "$5" == list && -n "${SHIM_LIST:-}" ]]; then
  printf '%s\n' "$SHIM_LIST"
  exit "${SHIM_LIST_RC:-0}"
fi
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
exec "$REAL_PNPM" "${args[@]}"
EOF
chmod +x "${shim_bin}/pnpm"
REAL_PNPM="$(command -v pnpm)"
export SHIM_LOG="${scratch}/pnpm.log" SHIM_PERSIST="${scratch}/d1" REAL_PNPM
mkdir "$SHIM_PERSIST"

d1() {
  wrangler_in "$WORKER_DIR" d1 execute watchtower --local --persist-to "$SHIM_PERSIST" "$@"
}
make_pending() {
  local name
  for name in "$@"; do
    d1 --command "DELETE FROM d1_migrations WHERE name = '${name}';" >/dev/null
  done
}
applied() {
  d1 --json --command "SELECT COUNT(*) AS n FROM d1_migrations WHERE name = '$1';" |
    jq -r '.[0].results[0].n == 1'
}

deploy() {
  : >"$SHIM_LOG"
  rc=0
  out="$(PATH="${shim_bin}:$PATH" bash "${SCRIPT_DIR}/deploy-worker.sh" "$@" 2>&1)" || rc=$?
}
steps() {
  sed -nE 's/^exec wrangler (d1 migrations (list|apply)|(deploy))( .*)?$/\2\3/p' "$SHIM_LOG" | paste -sd' ' -
}

wrangler_in "$WORKER_DIR" d1 migrations apply watchtower --local --persist-to "$SHIM_PERSIST" >/dev/null

make_pending "$GUARDED" "$UNGUARDED"
deploy </dev/null
refused "a pending precondition, no answer" "Not confirmed. Nothing applied or deployed."
check "a pending precondition, no answer: prompts" true "$(says "$PROMPT")"
check "a pending precondition, no answer: names the migration" true "$(says "  ${GUARDED}")"
check "a pending precondition, no answer: shows the precondition" true "$(says "    ${FIRST_PRECONDITION}")"
check "a migration without a precondition is not named" false "$(says "$UNGUARDED")"
check "a pending precondition, no answer: lists, never applies or deploys" "list" "$(steps)"
check "a pending precondition, no answer: nothing applied" "false false" "$(applied "$GUARDED") $(applied "$UNGUARDED")"

deploy <<<"no"
refused "a pending precondition, answered no" "Not confirmed"
check "a pending precondition, answered no: never applies or deploys" "list" "$(steps)"

deploy <<<"yes"
check "a pending precondition, answered yes: exits zero" 0 "$rc"
check "a pending precondition, answered yes: applies, then deploys" "list apply deploy" "$(steps)"
check "a pending precondition, answered yes: both applied" "true true" "$(applied "$GUARDED") $(applied "$UNGUARDED")"

make_pending "$GUARDED"
deploy --yes </dev/null
check "--yes: exits zero" 0 "$rc"
check "--yes: still shows the precondition" true "$(says "    ${FIRST_PRECONDITION}")"
check "--yes: does not prompt" false "$(says "$PROMPT")"
check "--yes: applies, then deploys" "list apply deploy" "$(steps)"
check "--yes: applied" true "$(applied "$GUARDED")"

make_pending "$UNGUARDED"
deploy </dev/null
check "pending without a precondition: exits zero" 0 "$rc"
check "pending without a precondition: does not prompt" false "$(says "$PROMPT")"
check "pending without a precondition: applies, then deploys" "list apply deploy" "$(steps)"
check "pending without a precondition: applied" true "$(applied "$UNGUARDED")"

deploy </dev/null
check "nothing pending: exits zero" 0 "$rc"
check "nothing pending: shows no precondition" false "$(says "precondition. Apply")"
check "nothing pending: applies, then deploys" "list apply deploy" "$(steps)"

deploy --force </dev/null
refused "an unknown argument" "Unknown argument: --force"
check "an unknown argument: runs nothing" "" "$(cat "$SHIM_LOG")"

SHIM_LIST="✘ [ERROR] Authentication error" SHIM_LIST_RC=1 deploy --yes </dev/null
refused "a failed list" "Listing the migrations pending on the remote D1 failed"
check "a failed list: never applies or deploys" "list" "$(steps)"

SHIM_LIST="Some future wrangler output" deploy --yes </dev/null
refused "a list wrangler words differently" "Could not read which migrations are pending"
check "a list wrangler words differently: never applies or deploys" "list" "$(steps)"

SHIM_LIST="Migrations to be applied:"$'\n'"| 0008-renamed.sql |" deploy --yes </dev/null
refused "a pending list naming no migration file" "Could not read which migrations are pending"

SHIM_LIST="✅ No migrations to apply!"$'\n'"│ ${GUARDED} │" deploy --yes </dev/null
refused "a list both empty and naming a file" "Could not read which migrations are pending"

make_n deploy-worker YES=1
check "make deploy-worker YES=1 passes --yes" "0 --yes" "$rc $out"
make_n deploy-worker YES=0
check "make deploy-worker YES=0 prompts" "0 " "$rc $out"
make_n deploy-worker
check "make deploy-worker prompts" "0 " "$rc $out"
make_n deploy YES=1
check "make deploy YES=1 passes --yes to deploy-worker" "0 --yes" "$rc $(head -1 <<<"$out")"
make_n deploy-worker YES=true
check "make deploy-worker YES=true is refused" "2 true" "$rc $(says "YES takes 0 or 1")"
rc=0
out="$(env YES=1 make -s -n -C "$REPO_ROOT" deploy-worker 2>&1)" || rc=$?
check "make deploy-worker with YES only in the environment is refused" "2 true" "$rc $(says "Pass YES on the make command line")"

finish migration-preconditions
