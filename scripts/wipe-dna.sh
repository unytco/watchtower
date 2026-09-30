#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "${SCRIPT_DIR}/_common.sh"

usage() {
  cat >&2 <<'EOF'
Usage: scripts/wipe-dna.sh [--local | --persist-to DIR] [--yes] <dna-hash>

Deletes one DNA's rows from the D1 database `watchtower`, remote unless --local or --persist-to.

  <dna-hash>        uhC0k… (53 chars) or hC0k… (52 chars)
  --local           use the local D1 that `wrangler dev` uses
  --persist-to DIR  use the local D1 state under DIR
  --yes             skip the confirmation prompt
EOF
  exit "$1"
}

local_mode=false
persist_to=""
assume_yes=false
dna_arg=""
while (($#)); do
  case "$1" in
    --local) local_mode=true ;;
    --persist-to)
      if [[ $# -lt 2 ]]; then
        err "--persist-to needs a directory."
        usage 1
      fi
      local_mode=true
      persist_to="$2"
      shift
      ;;
    --yes) assume_yes=true ;;
    -h | --help) usage 0 ;;
    -*)
      err "Unknown option: $1"
      usage 1
      ;;
    *)
      if [[ -n "$dna_arg" ]]; then
        err "One DNA hash per run."
        usage 1
      fi
      dna_arg="$1"
      ;;
  esac
  shift
done

if [[ -z "$dna_arg" ]]; then
  err "Missing DNA hash."
  usage 1
fi

is_dna_hash() {
  # In locales such as en_US.UTF-8, [A-Za-z] also matches letters such as é.
  local LC_ALL=C
  [[ "$1" =~ ^hC0k[A-Za-z0-9_-]{48}$ ]]
}

# D1 stores the bare form; the leading `u` is Holochain's multibase prefix.
dna="${dna_arg#u}"
if ! is_dna_hash "$dna"; then
  err "Not a DNA hash: '${dna_arg}'. Expected uhC0k… (53 chars) or hC0k… (52 chars) in base64url."
  exit 1
fi

require_cmd pnpm
require_cmd jq

if $local_mode; then
  target=(--local)
  target_desc="local D1 'watchtower'"
  if [[ -n "$persist_to" ]]; then
    target+=(--persist-to "$(cd "$persist_to" && pwd)")
    target_desc+=" in ${persist_to}"
  fi
else
  target=(--remote)
  target_desc="remote D1 'watchtower'"
fi

d1() {
  wrangler_in "$WORKER_DIR" d1 execute watchtower "${target[@]}" "$@"
}

template="$(grep -Ev '^[[:space:]]*(--|$)' "${SCRIPT_DIR}/wipe-dna.sql")"
statements="${template//__DNA__/$dna}"
n_statements="$(wc -l <<<"$statements")"
# One scalar subquery per table: D1 caps a compound SELECT below the number of tables.
counts="$(sed -nE 's/^DELETE FROM ([a-z_]+) WHERE (.+);$/(SELECT COUNT(*) FROM \1 WHERE \2) AS \1/p' <<<"$statements")"
if [[ "$(wc -l <<<"$counts")" -ne "$n_statements" ]]; then
  err "scripts/wipe-dna.sql: every statement must be one line of the form 'DELETE FROM <table> WHERE …;'"
  exit 1
fi
counts_sql="SELECT $(paste -sd, - <<<"$counts");"

count_rows() {
  local failure="$1" json
  if ! json="$(d1 --json --command "$counts_sql")" ||
    ! jq -e --argjson n "$n_statements" \
      '.[0].results[0] | length == $n and all(.[]; type == "number")' <<<"$json" >/dev/null 2>&1; then
    err "${failure}. Wrangler said:"
    echo "$json" >&2
    exit 1
  fi
  total="$(jq '[.[0].results[0][]] | add' <<<"$json")"
  per_table="$(jq -r '.[0].results[0] | to_entries[] | "\(.key)\t\(.value)"' <<<"$json" |
    awk -F'\t' -v total="$total" '{ printf "  %-22s %8d\n", $1, $2 } END { printf "  %-22s %8d\n", "total", total }')"
}

log "Rows for DNA ${dna} in ${target_desc}:"
count_rows "Counting rows failed. Nothing deleted"
echo "$per_table"
if ((total == 0)); then
  log "Nothing to delete: no rows for this DNA in the tables above."
  exit 0
fi

if ! $assume_yes; then
  ask_yes "Type the DNA hash or 'yes' to delete these ${total} rows from ${target_desc}" "Nothing deleted." "$dna" "u${dna}"
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
printf '%s\n' "$statements" >"${tmp_dir}/wipe-dna.sql"

log "Deleting..."
if ! d1 --yes --file "${tmp_dir}/wipe-dna.sql"; then
  err "The delete on ${target_desc} failed. Re-run to see which rows remain."
  exit 1
fi

count_rows "The delete ran but recounting failed. Re-run to see which rows remain"
if ((total)); then
  err "${total} rows remain for DNA ${dna}:"
  echo "$per_table" >&2
else
  log "No rows left for DNA ${dna} in the tables above."
fi
warn "Observers and bridge reporters still on this DNA re-create its rows on their next post: the wipe lasts only once the fleet no longer runs it."
if ((total)); then
  exit 1
fi
