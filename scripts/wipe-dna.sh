#!/usr/bin/env bash
#
# Delete every row of one DNA from the D1 database `watchtower`: show the
# per-table row counts, ask for confirmation, then run scripts/wipe-dna.sql.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "${SCRIPT_DIR}/_common.sh"

usage() {
  cat >&2 <<'EOF'
Usage: scripts/wipe-dna.sh [--local [--persist-to DIR]] [--yes] <dna-hash>

Deletes every row of one DNA from the D1 database `watchtower`, remote unless --local.

  <dna-hash>        uhC0k… (53 chars) or hC0k… (52 chars)
  --local           use the local D1 that `wrangler dev` uses
  --persist-to DIR  use the local D1 state under DIR (implies --local)
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
      [[ $# -ge 2 ]] || usage 1
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
  # In a UTF-8 locale [A-Za-z] also matches letters such as é.
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

statements="$(sed "s/__DNA__/${dna}/g" "${SCRIPT_DIR}/wipe-dna.sql" | grep -Ev '^[[:space:]]*(--|$)')"
n_statements="$(wc -l <<<"$statements")"
# One scalar subquery per table: D1 caps a compound SELECT below the number of tables.
counts="$(sed -nE 's/^DELETE FROM ([a-z_]+) WHERE (.+);$/(SELECT COUNT(*) FROM \1 WHERE \2) AS \1/p' <<<"$statements")"
if [[ "$(wc -l <<<"$counts")" -ne "$n_statements" ]]; then
  err "scripts/wipe-dna.sql: every statement must be one line of the form 'DELETE FROM <table> WHERE …;'"
  exit 1
fi
counts_sql="SELECT $(paste -sd, <<<"$counts");"

# Sets `total` and the printable `per_table` counts.
count_rows() {
  local json
  if ! json="$(d1 --json --command "$counts_sql")"; then
    err "Counting rows failed:"
    echo "$json" >&2
    exit 1
  fi
  if [[ "$(jq '.[0].results[0] | length' <<<"$json")" -ne "$n_statements" ]]; then
    err "Unexpected wrangler output:"
    echo "$json" >&2
    exit 1
  fi
  total="$(jq '[.[0].results[0][]] | add' <<<"$json")"
  per_table="$(jq -r '.[0].results[0] | to_entries[] | "\(.key)\t\(.value)"' <<<"$json" |
    awk -F'\t' -v total="$total" '{ printf "  %-22s %8d\n", $1, $2 } END { printf "  %-22s %8d\n", "total", total }')"
}

log "Rows for DNA ${dna} in ${target_desc}:"
count_rows
echo "$per_table"
if ((total == 0)); then
  log "Nothing to delete: no rows for this DNA."
  exit 0
fi

if ! $assume_yes; then
  answer=""
  read -r -p "Type the DNA hash or 'yes' to delete these ${total} rows from ${target_desc}: " answer || true
  if [[ "$answer" != "yes" && "$answer" != "$dna" && "$answer" != "$dna_arg" ]]; then
    err "Not confirmed. Nothing deleted."
    exit 1
  fi
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
printf '%s\n' "$statements" >"${tmp_dir}/wipe-dna.sql"

log "Deleting ${total} rows..."
d1 --yes --file "${tmp_dir}/wipe-dna.sql"

count_rows
if ((total)); then
  err "${total} rows remain for DNA ${dna}:"
  echo "$per_table" >&2
else
  log "No rows left for DNA ${dna}."
fi
warn "Observers still running this DNA re-create its rows on their next post."
warn "The wipe only lasts for a DNA the fleet no longer runs."
if ((total)); then
  exit 1
fi
