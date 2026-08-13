import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import schemaSql from "../src/schema.sql?raw";

// B107: a degraded observer read posts `null` for a derived metric, not a
// misleading 0. This proves the null survives ingest (the column is nullable as
// of migration 0005) and is served back as null by `/api/metrics`, so the
// dashboard can render it distinctly from a DNA that genuinely sits at zero.

const SECRET_HEX = "c".repeat(64);
const OBSERVER_ID = "degraded-observer";
const DNA_DEGRADED = "dna-degraded";
const DNA_IDLE = "dna-idle";

async function applySchema() {
  const stripped = schemaSql
    .split("\n")
    .filter((line: string) => !line.trim().startsWith("--"))
    .join("\n");
  const singleLine = stripped
    .split(/;\s*\n/)
    .map((s: string) => s.replace(/\s+/g, " ").trim())
    .filter((s: string) => s.length > 0)
    .map((s: string) => `${s};`)
    .join("\n");
  await env.DB.exec(singleLine);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO observer_secrets (observer_id, secret_hex, created_at) VALUES (?, ?, ?)",
  )
    .bind(OBSERVER_ID, SECRET_HEX, new Date().toISOString())
    .run();
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return toHex(new Uint8Array(d));
}
async function hmacHex(secretHex: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    fromHex(secretHex),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return toHex(new Uint8Array(sig));
}
function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

type DerivedMetrics = {
  integration_rate: number | null;
  lag_p50_ms: number | null;
  lag_p99_ms: number | null;
  pending_backlog: number | null;
};

function payload(dna_b64: string, derived_metrics: DerivedMetrics): object {
  return {
    schema_version: 1,
    observer_id: OBSERVER_ID,
    collected_at: new Date().toISOString(),
    self_health: {
      uptime_s: 60,
      last_collection_ms: 100,
      n_errors_this_cycle: 0,
      binary_version: "test",
    },
    node: {
      conductor: {
        holochain_version: "0.7.0",
        admin_port: 8888,
        running_apps: 1,
        paused_apps: 0,
        disabled_apps: 0,
        nonce_count: 1,
        nonce_duplicate_count: 0,
      },
      dnas: [
        {
          dna_b64,
          dna_tag: null,
          dna_definition: null,
          agents: [],
          warrants: [],
          chain_summaries: [],
          slice_hashes: [],
          chain_locks: [],
          scheduled_functions: [],
          validation_coverage: [],
          cap_grants: [],
          derived_metrics,
          pending_ops_count: 0,
          integrated_ops_count: 0,
        },
      ],
      apps: [],
      blocks: [],
    },
  };
}

async function ingest(bodyObj: unknown) {
  const body = new TextEncoder().encode(JSON.stringify(bodyObj));
  const ts = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const digest = await sha256Hex(body.buffer as ArrayBuffer);
  const sig = await hmacHex(SECRET_HEX, [OBSERVER_ID, ts, nonce, digest].join("\n"));
  const resp = await SELF.fetch(
    new Request("http://test/ingest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-watchtower-schema": "1",
        "x-watchtower-observer": OBSERVER_ID,
        "x-watchtower-ts": ts,
        "x-watchtower-nonce": nonce,
        "x-watchtower-sig": sig,
      },
      body,
    }),
  );
  return resp;
}

async function metricsFor(dna: string): Promise<Record<string, unknown>[]> {
  const resp = await SELF.fetch(`http://test/api/metrics?dna=${dna}`);
  expect(resp.status).toBe(200);
  const { metrics } = await resp.json<{ metrics: Record<string, unknown>[] }>();
  return metrics;
}

describe("degraded derived metrics", () => {
  beforeAll(async () => {
    await applySchema();
  });

  it("persists a degraded read as NULL and serves it back as null", async () => {
    const resp = await ingest(
      payload(DNA_DEGRADED, {
        integration_rate: null,
        lag_p50_ms: null,
        lag_p99_ms: null,
        pending_backlog: null,
      }),
    );
    // The nullable columns accept the degraded read rather than failing on a
    // NOT NULL constraint.
    expect(resp.status).toBe(200);

    const metrics = await metricsFor(DNA_DEGRADED);
    expect(metrics.length).toBe(1);
    expect(metrics[0].integration_rate).toBeNull();
    expect(metrics[0].lag_p50_ms).toBeNull();
    expect(metrics[0].lag_p99_ms).toBeNull();
    expect(metrics[0].pending_backlog).toBeNull();
  });

  it("keeps a genuine zero distinct from a degraded read", async () => {
    const resp = await ingest(
      payload(DNA_IDLE, {
        integration_rate: 0,
        lag_p50_ms: 0,
        lag_p99_ms: 0,
        pending_backlog: 0,
      }),
    );
    expect(resp.status).toBe(200);

    const metrics = await metricsFor(DNA_IDLE);
    expect(metrics.length).toBe(1);
    // A real zero stays 0 — the whole point of B107 is that this is NOT the
    // same as the null above.
    expect(metrics[0].integration_rate).toBe(0);
    expect(metrics[0].pending_backlog).toBe(0);
  });
});
