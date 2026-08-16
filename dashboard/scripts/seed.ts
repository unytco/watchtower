// Post synthetic snapshots to a locally-running Wrangler instance.
// Assumes the D1 `observer_secrets` table contains a matching row.
// Usage: pnpm seed -- --observer obs-dev --secret <hex> --url http://127.0.0.1:8787/ingest
import { createHmac, createHash, randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    observer: { type: "string", default: "obs-dev" },
    secret: { type: "string" },
    url: { type: "string", default: "http://127.0.0.1:8787/ingest" },
    schema: { type: "string", default: "1" },
  },
});
if (!values.secret) {
  console.error("--secret <hex> is required");
  process.exit(1);
}

const observerId = values.observer!;
const secretHex = values.secret!;
const url = values.url!;

const now = new Date();
const dna = b64url(randomBytes(32));
const agent = b64url(randomBytes(32));

const payload = {
  schema_version: Number(values.schema),
  observer_id: observerId,
  collected_at: now.toISOString(),
  self_health: {
    uptime_s: 600,
    last_collection_ms: 250,
    n_errors_this_cycle: 0,
    binary_version: "dev",
  },
  node: {
    conductor: {
      holochain_version: "0.4.0-dev",
      admin_port: 8888,
      running_apps: 1,
      paused_apps: 0,
      disabled_apps: 0,
      nonce_count: 10,
      nonce_duplicate_count: 0,
    },
    dnas: [
      {
        dna_b64: dna,
        dna_tag: "unyt-dev",
        dna_definition: {
          zomes: ["coordinator", "integrity"],
          properties_summary_json: "{}",
          network_seed: "dev",
        },
        agents: [
          {
            agent_b64: agent,
            agent_tag: "alice",
            first_seen_iso: now.toISOString(),
            last_seen_iso: now.toISOString(),
            action_count: 42,
            warrants_issued: 0,
            warrants_against: 0,
          },
        ],
        warrants: [],
        chain_summaries: [
          {
            agent_b64: agent,
            action_count: 42,
            first_ts_iso: now.toISOString(),
            last_ts_iso: now.toISOString(),
          },
        ],
        slice_hashes: [],
        chain_locks: [],
        scheduled_functions: [],
        validation_coverage: [],
        cap_grants: [],
        derived_metrics: {
          integration_rate: 1.0,
          lag_p50_ms: 50,
          lag_p99_ms: 300,
          pending_backlog: 0,
        },
        pending_ops_count: 0,
        integrated_ops_count: 42,
      },
    ],
    apps: [
      {
        app_id: "unyt-dev",
        happ_name: "unyt",
        role_name: "core",
        clone_of_app_id: null,
      },
    ],
    blocks: [],
  },
};

const body = Buffer.from(JSON.stringify(payload));
const ts = now.toISOString();
const nonce = b64url(randomBytes(16));
const digest = createHash("sha256").update(body).digest("hex");
const canonical = [observerId, ts, nonce, digest].join("\n");
const sig = createHmac("sha256", Buffer.from(secretHex, "hex")).update(canonical).digest("hex");

const resp = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-watchtower-schema": values.schema!,
    "x-watchtower-observer": observerId,
    "x-watchtower-ts": ts,
    "x-watchtower-nonce": nonce,
    "x-watchtower-sig": sig,
  },
  body,
});
console.log(resp.status, await resp.text());

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
