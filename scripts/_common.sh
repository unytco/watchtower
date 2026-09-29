# shellcheck shell=bash
# Shared helpers for bootstrap/deploy scripts. Source with `. scripts/_common.sh`.

log()  { echo -e "\033[0;32m[watchtower]\033[0m $*"; }
warn() { echo -e "\033[0;33m[watchtower]\033[0m $*"; }
err()  { echo -e "\033[0;31m[watchtower]\033[0m $*" >&2; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="${REPO_ROOT}/worker"
# shellcheck disable=SC2034
DASHBOARD_DIR="${REPO_ROOT}/dashboard"

# Pages' wrangler.jsonc does not accept `account_id`, and Pages commands
# error out when multiple accounts are available. Export CLOUDFLARE_ACCOUNT_ID
# once, derived from worker/wrangler.jsonc so both configs stay in sync.
if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" && -f "${WORKER_DIR}/wrangler.jsonc" ]]; then
  CLOUDFLARE_ACCOUNT_ID="$(grep -Eo '"account_id"[[:space:]]*:[[:space:]]*"[^"]+"' \
    "${WORKER_DIR}/wrangler.jsonc" | head -1 | sed -E 's/.*"([^"]+)"$/\1/' || true)"
  if [[ -n "$CLOUDFLARE_ACCOUNT_ID" ]]; then
    export CLOUDFLARE_ACCOUNT_ID
  fi
fi

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "Missing required command: $cmd"
    exit 1
  fi
}

wrangler_in() {
  local dir="$1"; shift
  (cd "$dir" && pnpm exec wrangler "$@")
}

take_yes_flag() {
  assume_yes=false
  while (($#)); do
    case "$1" in
      --yes) assume_yes=true ;;
      *)
        err "Unknown argument: $1. The only option is --yes, which confirms a pending migration's precondition."
        exit 1
        ;;
    esac
    shift
  done
}

# Sets `pending` to the files `d1 migrations apply watchtower --remote` would apply, as wrangler's
# own list names them. The list is a table with no JSON form, so output it does not recognise stops the script.
list_pending_migrations() {
  local listing file
  pending=()
  if ! listing="$(wrangler_in "$WORKER_DIR" d1 migrations list watchtower --remote)"; then
    err "Listing the migrations pending on the remote D1 failed. Nothing applied or deployed."
    exit 1
  fi
  for file in "$WORKER_DIR"/migrations/*.sql; do
    if [[ "$listing" == *" ${file##*/} "* ]]; then
      pending+=("$file")
    fi
  done
  if [[ ${#pending[@]} -gt 0 && "$listing" == *"Migrations to be applied:"* ]] ||
    [[ ${#pending[@]} -eq 0 && "$listing" == *"No migrations to apply!"* ]]; then
    return 0
  fi
  err "Could not read which migrations are pending on the remote D1. Nothing applied or deployed. Wrangler said:"
  echo "$listing" >&2
  exit 1
}

confirm_pending_preconditions() {
  local assume_yes="$1" file lines shown="" answer=""
  list_pending_migrations
  for file in ${pending[@]+"${pending[@]}"}; do
    lines="$(sed -nE 's/^--[[:space:]]*precondition:[[:space:]]*/    /p' "$file")"
    if [[ -n "$lines" ]]; then
      shown+="  ${file##*/}"$'\n'"${lines}"$'\n'
    fi
  done
  if [[ -z "$shown" ]]; then
    return 0
  fi
  warn "Pending migrations declare a precondition. Apply them only once it holds:"
  printf '%s' "$shown"
  if $assume_yes; then
    log "Confirmed by --yes."
    return 0
  fi
  printf "Type 'yes' to confirm it holds and apply the pending migrations: " >&2
  read -r answer || true
  if [[ "$answer" != yes ]]; then
    err "Not confirmed. Nothing applied or deployed. Scripted runs pass --yes (make: YES=1)."
    exit 1
  fi
}
