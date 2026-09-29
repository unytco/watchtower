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

# ask_yes QUESTION UNDONE [ANSWER...]: exits unless the operator types yes or one of ANSWER.
ask_yes() {
  local question="$1" undone="$2" answer="" accepted
  shift 2
  printf '%s: ' "$question" >&2
  read -r answer || true
  for accepted in yes "$@"; do
    if [[ "$answer" == "$accepted" ]]; then
      return 0
    fi
  done
  err "Not confirmed. ${undone} Scripted runs pass --yes (make: YES=1)."
  exit 1
}

take_yes_flag() {
  assume_yes=false
  while (($#)); do
    case "$1" in
      --yes) assume_yes=true ;;
      *)
        err "Unknown argument: $1. The only option is --yes, which accepts a pending migration's preconditions."
        exit 1
        ;;
    esac
    shift
  done
}

# list_pending_migrations STOPPED: sets `pending` to the files `d1 migrations apply watchtower --remote`
# would apply, read from the table wrangler's own list prints. The list has no JSON form, so a table
# this does not recognise, or a row naming no file, stops the run with STOPPED instead of passing
# for an empty list.
list_pending_migrations() {
  local stopped="$1" listing rows name
  pending=()
  if ! listing="$(WRANGLER_LOG=log wrangler_in "$WORKER_DIR" d1 migrations list watchtower --remote)"; then
    err "Listing the migrations pending on the remote D1 failed. ${stopped} If wrangler asks for CLOUDFLARE_API_TOKEN, this machine is not logged in: run make login, then the same make target again."
    echo "$listing" >&2
    exit 1
  fi
  rows="$(sed -nE -e $'s/\033\\[[0-9;]*m//g' -e 's/^│ (.*[^ ]) +│$/\1/p' <<<"$listing")"
  if [[ -z "$rows" && "$listing" == *"No migrations to apply!"* ]]; then
    return 0
  fi
  if [[ "$listing" == *"Migrations to be applied:"* && "$rows" == Name$'\n'* ]]; then
    while IFS= read -r name; do
      if [[ ! -f "${WORKER_DIR}/migrations/${name}" || ! -r "${WORKER_DIR}/migrations/${name}" ]]; then
        pending=()
        break
      fi
      pending+=("${WORKER_DIR}/migrations/${name}")
    done <<<"${rows#Name$'\n'}"
    if ((${#pending[@]})); then
      return 0
    fi
  fi
  err "Could not read which migrations are pending on the remote D1. ${stopped} Wrangler said:"
  echo "$listing" >&2
  exit 1
}

confirm_pending_preconditions() {
  local assume_yes="$1" file unread shown=""
  list_pending_migrations "Nothing applied or deployed."
  for file in ${pending[@]+"${pending[@]}"}; do
    unread="$(grep -i precondition "$file" | grep -v '^-- precondition: ' || true)"
    if [[ -n "$unread" ]]; then
      err "${file##*/} mentions a precondition in a form this cannot read. Nothing applied or deployed. Write each as '-- precondition: <text>':"
      echo "$unread" >&2
      exit 1
    fi
    if grep -q '^-- precondition: ' "$file"; then
      shown+="  ${file##*/}"$'\n'"$(sed -n 's/^-- precondition: /    /p' "$file")"$'\n'
    fi
  done
  if [[ -z "$shown" ]]; then
    return 0
  fi
  warn "Pending migrations declare preconditions:" >&2
  printf '%s' "$shown" >&2
  if [[ "$assume_yes" == true ]]; then
    log "Accepted by --yes." >&2
    return 0
  fi
  ask_yes "Type 'yes' to accept them and apply the pending migrations" "Nothing applied or deployed."
}

# apply_pending_migrations STOPPED: applies the pending migrations, then stops the run with STOPPED
# while any remain, since wrangler exits 0 when its own "continue?" is answered no.
apply_pending_migrations() {
  local stopped="$1"
  log "Applying D1 migrations (remote)..."
  if ! wrangler_in "$WORKER_DIR" d1 migrations apply watchtower --remote; then
    err "Applying the migrations failed. Wrangler's error above names the cause. ${stopped}"
    exit 1
  fi
  list_pending_migrations "$stopped"
  if ((${#pending[@]})); then
    err "Migrations are still pending after the apply: ${pending[*]##*/}. ${stopped}"
    exit 1
  fi
}
