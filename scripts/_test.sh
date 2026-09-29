# shellcheck shell=bash
# Shared checks for the operator-script tests. Source after _common.sh.

# A wrangler call that escapes a test's pnpm shim authenticates with this and fails.
export CLOUDFLARE_API_TOKEN=operator-script-tests-hold-no-token

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

says() {
  [[ "$out" == *"$1"* ]] && echo true || echo false
}

refused() {
  local what="$1" message="$2"
  check "${what}: exits nonzero" 1 "$rc"
  check "${what}: says '${message}'" true "$(says "$message")"
}

logged() {
  grep -q -- "$1" "$SHIM_LOG" && echo true || echo false
}

make_n() {
  rc=0
  out="$(make -s -n -C "$REPO_ROOT" "$@" 2>&1)" || rc=$?
  out="$(tr -s ' ' <<<"$out" | sed -E 's|.*/scripts/||; s/ $//')"
}

finish() {
  if ((failures)); then
    err "${failures} check(s) failed."
    exit 1
  fi
  log "All $1 checks passed."
}
