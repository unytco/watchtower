# Deploying unyt-watchtower

This runbook covers the one-time bring-up of the Cloudflare infrastructure
(Worker + D1 + Pages dashboard, all on `watchtower.unyt.dev`) and the
subsequent everyday redeploy flow.

Per-server observer install (the part that actually collects data from a
Holochain node) lives in the `automation/` repo; see
`automation/scripts/setup-watchtower-observer.sh` and the per-server
Makefile targets such as `heart-always-online-2-watchtower`.

## Prerequisites

You need all of these before running any `make` target:

- `nix`, `pnpm`, `jq`, `curl` on your workstation.
- A Cloudflare account with the `unyt.dev` zone already on Cloudflare (the
  existing `automation/infra/cf-config-worker/wrangler.toml` confirms the zone
  is in place).
- SSH access to the target Holochain node(s) as `root`.

## Manual steps (do these first, in any order)

Only two things need a human in the loop. Everything else is `make`.

### 1. Wrangler login (once per workstation)

```bash
cd unyt-watchtower
nix develop           # optional but recommended
pnpm wrangler login   # opens your browser; follow the OAuth flow
```

Or `make login`, which is just a wrapper around the above.

### 2. DNS record for `watchtower.unyt.dev`

In the Cloudflare dashboard for `unyt.dev`:

- Add a **proxied** (orange cloud) record named `watchtower`.
- Type: `A` with any value (e.g. `192.0.2.1`) or `CNAME` to any target — the
  value is irrelevant because Workers/Pages routes override the response.
- TTL: Auto.

Cloudflare will provision a TLS certificate automatically; usually ready
within a few minutes, occasionally up to an hour.

### 3. Bind `watchtower.unyt.dev` to the Pages project

Wrangler 4.x has no CLI for Pages custom-domain binding, so this step is
either a one-click in the dashboard or an API call. Pick one:

- **Dashboard** (easiest): after `make bootstrap` prints the URL, open
  `https://dash.cloudflare.com/<account-id>/pages/view/unyt-watchtower-dashboard/domains`
  and click **Set up a custom domain** → enter `watchtower.unyt.dev`.
- **API** (automatable): create a Cloudflare API token with the
  `Pages:Edit` scope, export it, and re-run `make bootstrap-pages`:

  ```bash
  export CLOUDFLARE_API_TOKEN=...
  make bootstrap-pages
  ```

  The script detects the token and binds the domain via the REST API.

## One-time bring-up

From `unyt-watchtower/` (ideally inside `nix develop`):

```bash
make install      # pnpm install in worker/ + dashboard/
make bootstrap    # create D1, patch wrangler.jsonc, migrate, create Pages project, bind domain
make deploy       # deploy Worker + dashboard
make secrets      # optional: set RESEND_API_KEY + ALERT_FROM_ADDRESS for email alerts
```

Each target is idempotent: rerunning `make bootstrap` is a no-op once D1 and
the Pages project exist, and `make deploy` is what you run every time you
want to push an update.

### Sanity check

```bash
curl https://watchtower.unyt.dev/healthz
# -> ok

curl https://watchtower.unyt.dev/api/observers
# -> {"observers":[]}

open https://watchtower.unyt.dev/
# -> dashboard renders with "No observers reporting yet."
```

## Redeploy (everyday flow)

```bash
cd unyt-watchtower
make deploy                # worker + dashboard
# or individually:
make deploy-worker
make deploy-dashboard
```

`make status` shows the last few Worker and Pages deployments so you can
confirm what's currently live.

## Installing the observer on a server

The Cloudflare side must be up first (otherwise the observer cannot register
its secret or POST snapshots). Then from the `automation/` repo:

```bash
cd automation
make heart-always-online-2-watchtower   # or any other <server>-watchtower target
```

This runs `automation/scripts/setup-watchtower-observer.sh`, which:

1. Builds `hc-watchtower-observer` and `hc-watchtower` on your workstation
   (inside `nix develop` if `unyt-watchtower/flake.nix` is present).
2. Copies both binaries to the server.
3. Writes `/etc/hc-watchtower/observer.toml`, `/etc/hc-watchtower/ingest.secret`
   (0600), and the systemd unit.
4. Creates `/var/lib/hc-watchtower/exports/`.
5. Registers a freshly-generated observer secret in the D1 `observer_secrets`
   table via `wrangler d1 execute`.
6. Enables and starts `hc-watchtower-observer.service`.

Verify on the server:

```bash
ssh root@<server> systemctl status hc-watchtower-observer
ssh root@<server> journalctl -u hc-watchtower-observer -f
ssh root@<server> hc-watchtower status
```

And in the dashboard at `https://watchtower.unyt.dev/`, the observer should
appear in the header switcher within one collection interval (60s by default).

## What's interactive and why

| Step                  | Interactive? | Reason                                                   |
| --------------------- | ------------ | -------------------------------------------------------- |
| `pnpm wrangler login` | Yes          | OAuth flow; cached in `~/.wrangler/` afterwards          |
| DNS record            | Yes (once)   | Cloudflare dashboard click; could be scripted via API    |
| Pages custom domain   | Yes (once)   | Dashboard click or `CLOUDFLARE_API_TOKEN` + rerun        |
| `make install`        | No           |                                                          |
| `make bootstrap`      | No           | `bootstrap-d1.sh` / `bootstrap-pages.sh` are idempotent  |
| `make deploy`         | No           |                                                          |
| `make secrets`        | Yes (once)   | Reads values silently so they don't land in shell history |

## Troubleshooting

| Symptom                                             | Fix                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| `bootstrap-d1.sh`: "D1 'watchtower' already exists" | Expected. Script skips create, still applies migrations.            |
| `wrangler.jsonc` still has `REPLACE_ME_LOCAL_DEV`   | Run `make bootstrap-d1` (it patches the file via `sed`).            |
| "Route conflict" on deploy                          | Another Worker in the account owns `watchtower.unyt.dev`. Remove it. |
| `curl /healthz` returns 522 / SSL error             | DNS record missing or Pages/Worker cert still provisioning. Wait.    |
| Pages custom domain shows "pending"                 | Cloudflare ACME run. Retry after a few minutes.                     |
| Observer logs `401 unknown observer`                | D1 `observer_secrets` row missing. Rerun the `*-watchtower` target. |
| Observer logs `409 schema mismatch`                 | `SCHEMA_VERSION` in `worker/wrangler.jsonc` differs from observer.   |

## Rollback

- Worker: `cd worker && pnpm exec wrangler rollback`.
- Pages: go to the Cloudflare dashboard -> Pages -> `unyt-watchtower-dashboard`
  -> Deployments, click "Rollback" on any previous deployment.
- D1 schema: there is no automatic down-migration; add a new migration file
  under `worker/migrations/` and run `make bootstrap-d1` to apply it.
