#!/usr/bin/env bash
#
# Build the Vite dashboard and deploy to Cloudflare Pages.
# Assumes the Pages project and custom domain have been bootstrapped.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "${SCRIPT_DIR}/_common.sh"

require_cmd pnpm

PROJECT="unyt-watchtower-dashboard"

log "Installing dashboard dependencies..."
(cd "$DASHBOARD_DIR" && pnpm install --frozen-lockfile=false)

log "Building dashboard..."
(cd "$DASHBOARD_DIR" && pnpm build)

log "Deploying to Cloudflare Pages project '$PROJECT'..."
wrangler_in "$DASHBOARD_DIR" pages deploy dist \
  --project-name "$PROJECT" \
  --branch main

log "Dashboard deploy complete."
