# unyt-watchtower Makefile
# Usage: make <target>
#
# One-time bring-up:
#   pnpm wrangler login             (interactive, once per machine)
#   # add DNS record for watchtower.unyt.dev in Cloudflare dashboard
#   make install bootstrap deploy secrets
#
# Redeploy later:
#   make deploy

ROOT_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
SCRIPTS  := $(ROOT_DIR)scripts

.PHONY: help install bootstrap bootstrap-d1 bootstrap-pages \
        deploy deploy-worker deploy-dashboard secrets \
        status login test typecheck

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

install: ## pnpm install for worker + dashboard
	cd $(ROOT_DIR)worker     && pnpm install
	cd $(ROOT_DIR)dashboard  && pnpm install

login: ## Interactive: pnpm wrangler login (once per workstation)
	cd $(ROOT_DIR)worker && pnpm exec wrangler login

bootstrap-d1: ## One-time: create D1 `watchtower`, patch wrangler.jsonc, apply migrations
	bash $(SCRIPTS)/bootstrap-d1.sh

bootstrap-pages: ## One-time: create Pages project `unyt-watchtower-dashboard` + bind watchtower.unyt.dev
	bash $(SCRIPTS)/bootstrap-pages.sh

bootstrap: bootstrap-d1 bootstrap-pages ## One-time: D1 + Pages setup

deploy-worker: ## Deploy the Worker
	bash $(SCRIPTS)/deploy-worker.sh

deploy-dashboard: ## Build + deploy the Pages dashboard
	bash $(SCRIPTS)/deploy-dashboard.sh

deploy: deploy-worker deploy-dashboard ## Deploy both Worker and dashboard

secrets: ## Interactively set Worker secrets (RESEND_API_KEY, ALERT_FROM_ADDRESS)
	bash $(SCRIPTS)/secrets.sh

status: ## Show recent Worker + Pages deployments
	@echo "── Worker deployments ──"
	@cd $(ROOT_DIR)worker && pnpm exec wrangler deployments list 2>/dev/null | head -20 || true
	@echo
	@echo "── Pages deployments ──"
	@cd $(ROOT_DIR)dashboard && pnpm exec wrangler pages deployment list --project-name unyt-watchtower-dashboard 2>/dev/null | head -20 || true

test: ## Run Rust + Worker + dashboard tests
	cd $(ROOT_DIR) && cargo test --workspace
	cd $(ROOT_DIR)worker && pnpm test

typecheck: ## Typecheck Worker + dashboard
	cd $(ROOT_DIR)worker    && pnpm typecheck
	cd $(ROOT_DIR)dashboard && pnpm typecheck
