import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import schemaSql from "../src/schema.sql?raw";
import bridgeMigration from "../migrations/0002_bridge.sql?raw";
import unclassifiedMigration from "../migrations/0006_bridge_unclassified_streak.sql?raw";

// End-to-end coverage for the bridge's unclassified-failure streak (B111):
// POST a reporter payload carrying `unclassified_active` /
// `unclassified_consecutive`, then read them back off `/api/dnas/:dna/bridge`.
// The pair is the alertable twin of `pressure_active` / `pressure_consecutive`,
// so each case pins that the two classes stay independent — a payload in one
// class must never light up the other.
//
// The bridge tables live in migration 0002 (not `schema.sql`), and 0006 adds
// the two columns on top, so the fixture applies all three in order exactly as
// a real D1 reaches this shape.

const SECRET_HEX = "c".repeat(64);
const OBSERVER_ID = "bridge-unclassified";
const DNA = "dna-bridge-unclassified";

async function applySchema() {
  const toExec = (sql: string) => {
    const stripped = sql
      .split("\n")
      .filter((line: string) => !line.trim().startsWith("--"))
      .join("\n");
    return stripped
      .split(/;\s*\n/)
      .map((s: string) => s.replace(/\s+/g, " ").trim())
      .filter((s: string) => s.length > 0)
      .map((s: string) => `${s};`)
      .join("\n");
  };
  await env.DB.exec(toExec(schemaSql));
  await env.DB.exec(toExec(bridgeMigration));
  await env.DB.exec(toExec(unclassifiedMigration));
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

/**
 * A reporter payload. `selfHealthOverrides` is spread last so a case can both
 * set the streak fields and — by passing `undefined` — model a bridge that
 * predates them.
 */
function payload(selfHealthOverrides: Record<string, unknown>): object {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    observer_id: OBSERVER_ID,
    collected_at: now,
    dna_b64: DNA,
    self_health: {
      uptime_s: 120,
      binary_version: "test",
      last_cycle_at_iso: now,
      last_cycle_ms: 250,
      consecutive_failed_cycles: 0,
      reconnect_failures_total: 0,
      reconnects_ok_total: 0,
      pressure_active: false,
      pressure_consecutive: 0,
      unclassified_active: false,
      unclassified_consecutive: 0,
      stage_ejections_total: 0,
      is_stuck: false,
      last_error: null,
      last_error_at_iso: null,
      ...selfHealthOverrides,
    },
    backlog: {
      detected: 0,
      queued: 0,
      claimed: 0,
      in_flight: 0,
      succeeded_total: 0,
      failed_total: 0,
      oldest_queued_age_s: null,
    },
    throughput: {
      succeeded_1h: 0,
      failed_1h: 0,
      succeeded_24h: 0,
      failed_24h: 0,
      avg_time_to_succeed_s_24h: null,
    },
  };
}

async function ingestBridge(bodyObj: unknown): Promise<Response> {
  const body = new TextEncoder().encode(JSON.stringify(bodyObj));
  const ts = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const digest = await sha256Hex(body.buffer as ArrayBuffer);
  const sig = await hmacHex(SECRET_HEX, [OBSERVER_ID, ts, nonce, digest].join("\n"));
  return SELF.fetch(
    new Request("http://test/ingest/bridge", {
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
}

type ServiceRow = Record<string, number | string | null>;

async function readService(): Promise<ServiceRow> {
  const { services } = await (
    await SELF.fetch(`http://test/api/dnas/${DNA}/bridge`)
  ).json<{ services: ServiceRow[] }>();
  expect(services).toHaveLength(1);
  return services[0];
}

describe("bridge unclassified-error streak", () => {
  beforeEach(async () => {
    await env.DB.exec("DROP TABLE IF EXISTS bridge_services;");
    await env.DB.exec("DROP TABLE IF EXISTS bridge_backlog;");
    await env.DB.exec("DROP TABLE IF EXISTS bridge_throughput_ts;");
    await applySchema();
  });

  it("persists and serves the streak, leaving the pressure pair clear", async () => {
    const resp = await ingestBridge(
      payload({
        unclassified_active: true,
        unclassified_consecutive: 4,
        consecutive_failed_cycles: 4,
        last_error: "guest error: validation failed",
      }),
    );
    expect(resp.status).toBe(200);

    const service = await readService();
    expect(service.unclassified_active).toBe(1);
    expect(service.unclassified_consecutive).toBe(4);
    // The classes are independent: an unclassified streak must not read as
    // source-chain pressure, which would send an operator after the conductor.
    expect(service.pressure_active).toBe(0);
    expect(service.pressure_consecutive).toBe(0);
  });

  it("keeps the pressure pair readable without lighting up the new class", async () => {
    const resp = await ingestBridge(
      payload({
        pressure_active: true,
        pressure_consecutive: 3,
        consecutive_failed_cycles: 3,
      }),
    );
    expect(resp.status).toBe(200);

    const service = await readService();
    expect(service.pressure_active).toBe(1);
    expect(service.pressure_consecutive).toBe(3);
    expect(service.unclassified_active).toBe(0);
    expect(service.unclassified_consecutive).toBe(0);
  });

  it("clears a stored streak when a later report comes back clean", async () => {
    expect(
      (
        await ingestBridge(
          payload({ unclassified_active: true, unclassified_consecutive: 2 }),
        )
      ).status,
    ).toBe(200);
    expect((await readService()).unclassified_consecutive).toBe(2);

    // A clean cycle resets both fields on the orchestrator; the upsert must
    // carry that reset through rather than latching the old streak.
    expect((await ingestBridge(payload({}))).status).toBe(200);
    const service = await readService();
    expect(service.unclassified_active).toBe(0);
    expect(service.unclassified_consecutive).toBe(0);
  });

  it("accepts a pre-B111 payload that omits the fields, storing the 0 defaults", async () => {
    // A bridge that has not been redeployed still posts bridge schema v1
    // without the new fields. Ingest must not reject it (no schema bump) and
    // must not bind `undefined` into the NOT NULL columns.
    const resp = await ingestBridge(
      payload({ unclassified_active: undefined, unclassified_consecutive: undefined }),
    );
    expect(resp.status).toBe(200);

    const service = await readService();
    expect(service.unclassified_active).toBe(0);
    expect(service.unclassified_consecutive).toBe(0);
  });
});
