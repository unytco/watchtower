import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import schemaSql from "../src/schema.sql?raw";

// End-to-end coverage for the per-DNA migration counters: ingest a snapshot
// carrying the observer's two derived booleans, then read them back as the
// `/summary` counters and the per-agent `/agents` flags. Re-ingesting the same
// agents proves the upsert keeps the table bounded by fleet size (AC 3).

const SECRET_HEX = "b".repeat(64);
const OBSERVER_ID = "migration-observer";
const DNA = "dna-migration";
const AGENT_CLOSED = "agent-closed";
const AGENT_OPENED = "agent-opened";
const AGENT_PLAIN = "agent-plain";

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

function agent(agent_b64: string, chain_closed: boolean, opening_summary_present: boolean) {
  const now = new Date().toISOString();
  return {
    agent_b64,
    agent_tag: null,
    first_seen_iso: now,
    last_seen_iso: now,
    action_count: 1,
    warrants_issued: 0,
    warrants_against: 0,
    chain_closed,
    opening_summary_present,
  };
}

function payload(agents: ReturnType<typeof agent>[]): object {
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
        holochain_version: "0.6.0",
        admin_port: 8888,
        running_apps: 1,
        paused_apps: 0,
        disabled_apps: 0,
        nonce_count: 1,
        nonce_duplicate_count: 0,
      },
      dnas: [
        {
          dna_b64: DNA,
          dna_tag: "migration",
          dna_definition: null,
          agents,
          warrants: [],
          chain_summaries: [],
          slice_hashes: [],
          chain_locks: [],
          scheduled_functions: [],
          validation_coverage: [],
          cap_grants: [],
          derived_metrics: {
            integration_rate: 0,
            lag_p50_ms: 0,
            lag_p99_ms: 0,
            pending_backlog: 0,
          },
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
  expect(resp.status).toBe(200);
}

async function rowCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM agents_discovered WHERE dna_b64 = ?")
    .bind(DNA)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

async function storedFlags(
  agent_b64: string,
): Promise<{ chain_closed: number; opening_summary_present: number }> {
  const row = await env.DB.prepare(
    `SELECT chain_closed, opening_summary_present
       FROM agents_discovered
      WHERE observer_id = ? AND dna_b64 = ? AND agent_b64 = ?`,
  )
    .bind(OBSERVER_ID, DNA, agent_b64)
    .first<{ chain_closed: number; opening_summary_present: number }>();
  return row ?? { chain_closed: 0, opening_summary_present: 0 };
}

describe("migration counters", () => {
  beforeAll(async () => {
    await applySchema();
  });

  it("surfaces counters and per-agent flags from an ingested snapshot", async () => {
    await ingest(
      payload([
        agent(AGENT_CLOSED, true, false),
        agent(AGENT_OPENED, false, true),
        agent(AGENT_PLAIN, false, false),
      ]),
    );

    const summary = await (
      await SELF.fetch(`http://test/api/dnas/${DNA}/summary`)
    ).json<Record<string, number>>();
    expect(summary.agents).toBe(3);
    expect(summary.agents_closed).toBe(1);
    expect(summary.agents_opened).toBe(1);

    const { agents } = await (
      await SELF.fetch(`http://test/api/dnas/${DNA}/agents`)
    ).json<{ agents: Record<string, unknown>[] }>();
    const closed = agents.find((a) => a.agent_b64 === AGENT_CLOSED)!;
    expect(closed.chain_closed).toBe(1);
    expect(closed.opening_summary_present).toBe(0);
    const opened = agents.find((a) => a.agent_b64 === AGENT_OPENED)!;
    expect(opened.chain_closed).toBe(0);
    expect(opened.opening_summary_present).toBe(1);
    const plain = agents.find((a) => a.agent_b64 === AGENT_PLAIN)!;
    expect(plain.chain_closed).toBe(0);
    expect(plain.opening_summary_present).toBe(0);
  });

  it("re-ingesting the same agents upserts in place — the table stays fleet-sized", async () => {
    // Storage is isolated per test, so seed this test's own fleet first.
    await ingest(
      payload([
        agent(AGENT_CLOSED, true, false),
        agent(AGENT_OPENED, false, true),
        agent(AGENT_PLAIN, false, false),
      ]),
    );
    const before = await rowCount();
    expect(before).toBe(3);

    // Same agent keys, a later snapshot: AGENT_OPENED has now also closed.
    await ingest(
      payload([
        agent(AGENT_CLOSED, true, false),
        agent(AGENT_OPENED, true, true),
        agent(AGENT_PLAIN, false, false),
      ]),
    );

    // No new rows: bounded by fleet size, not by how many windows elapse.
    expect(await rowCount()).toBe(before);

    // The flag update is reflected: AGENT_OPENED now counts as closed too.
    const summary = await (
      await SELF.fetch(`http://test/api/dnas/${DNA}/summary`)
    ).json<Record<string, number>>();
    expect(summary.agents).toBe(3);
    expect(summary.agents_closed).toBe(2);
    expect(summary.agents_opened).toBe(1);
  });

  it("never regresses a set migration flag when a later snapshot reports false", async () => {
    // Close/Open are monotonic. Seed the agent as closed, then re-ingest the
    // same agent with the flag back to false — a transient DHT read miss. The
    // stored 1 must survive (MAX upsert), and no extra row may appear.
    await ingest(payload([agent(AGENT_CLOSED, true, false)]));
    expect((await storedFlags(AGENT_CLOSED)).chain_closed).toBe(1);
    const before = await rowCount();

    await ingest(payload([agent(AGENT_CLOSED, false, false)]));

    // Flag latched at 1, and the row was updated in place (no growth).
    expect((await storedFlags(AGENT_CLOSED)).chain_closed).toBe(1);
    expect(await rowCount()).toBe(before);

    const summary = await (
      await SELF.fetch(`http://test/api/dnas/${DNA}/summary`)
    ).json<Record<string, number>>();
    expect(summary.agents_closed).toBe(1);
  });

  it("counts an agent once when only one observer has seen its close", async () => {
    // Two observers report the same agent on the same DNA; only one has
    // observed the CloseChain yet. The counter must still be 1 (MAX dedup),
    // never double-counted, and never zero just because the other lags.
    const now = new Date().toISOString();
    const seedAgent = (observer: string, closed: number) =>
      env.DB.prepare(
        `INSERT OR REPLACE INTO agents_discovered (observer_id, dna_b64, agent_b64, agent_tag,
               first_seen_iso, last_seen_iso, action_count, warrants_issued, warrants_against,
               chain_closed, opening_summary_present, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(observer, "dna-split", "shared", null, now, now, 1, 0, 0, closed, 0, now);

    await env.DB.batch([seedAgent("obs-a", 1), seedAgent("obs-b", 0)]);

    const summary = await (
      await SELF.fetch("http://test/api/dnas/dna-split/summary")
    ).json<Record<string, number>>();
    expect(summary.agents).toBe(1);
    expect(summary.agents_closed).toBe(1);
  });
});
