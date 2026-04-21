# Shared helpers for bootstrap/deploy scripts. Source with `. scripts/_common.sh`.
# No shebang: always sourced.

log()  { echo -e "\033[0;32m[watchtower]\033[0m $*"; }
warn() { echo -e "\033[0;33m[watchtower]\033[0m $*"; }
err()  { echo -e "\033[0;31m[watchtower]\033[0m $*" >&2; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="${REPO_ROOT}/worker"
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
