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
        deploy deploy-worker deploy-dashboard secrets seed-alerts \
        status login test typecheck wipe-dna

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

seed-alerts: ## Provision default alert rules (override with WORKER_URL / RECIPIENT env vars)
	bash $(SCRIPTS)/seed-alert-rules.sh

wipe-dna: ## Delete one DNA's rows from the remote D1: DNA=<hash>, LOCAL=1 for the local one, YES=1 skips the prompt
	$(if $(filter command line,$(origin DNA)),,$(error Pass the hash as make wipe-dna DNA=<hash>))
	$(foreach v,LOCAL YES,$(if $(filter environment%,$(origin $v)),$(error Pass $v on the make command line)))
	$(if $(filter-out 0 1,$(LOCAL) $(YES)),$(error LOCAL and YES take 0 or 1))
	bash $(SCRIPTS)/wipe-dna.sh $(if $(filter 1,$(LOCAL)),--local) $(if $(filter 1,$(YES)),--yes) "$$DNA"

status: ## Show recent Worker + Pages deployments
	@echo "── Worker deployments ──"
	@cd $(ROOT_DIR)worker && pnpm exec wrangler deployments list 2>/dev/null | head -20 || true
	@echo
	@echo "── Pages deployments ──"
	@cd $(ROOT_DIR)dashboard && pnpm exec wrangler pages deployment list --project-name unyt-watchtower-dashboard 2>/dev/null | head -20 || true

test: ## Run Rust + Worker + operator-script tests
	cd $(ROOT_DIR) && cargo test --workspace
	cd $(ROOT_DIR)worker && pnpm test
	bash $(SCRIPTS)/wipe-dna.test.sh
	bash $(SCRIPTS)/wrangler.test.sh

typecheck: ## Typecheck Worker + dashboard
	cd $(ROOT_DIR)worker    && pnpm typecheck
	cd $(ROOT_DIR)dashboard && pnpm typecheck
