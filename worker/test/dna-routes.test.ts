import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import schemaSql from "../src/schema.sql?raw";

const DNA_A = "dna-alpha";
const DNA_B = "dna-beta";
const OBS_X = "obs-x";
const OBS_Y = "obs-y";
const AGENT_1 = "agent-1";
const AGENT_2 = "agent-2";
const AGENT_3 = "agent-3";

async function applySchema() {
  // D1's exec() requires each statement on a single line terminated by `;`.
  // Strip comments, collapse whitespace inside each statement, then feed the
  // whole file as a single exec call.
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
}

async function seed() {
  const now = new Date().toISOString();
  const DB = env.DB;

  await DB.batch([
    DB.prepare(
      `INSERT INTO observers (observer_id, last_seen_iso, last_collection_ms, uptime_s,
                              schema_version, n_errors, is_healthy, binary_version)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).bind(OBS_X, now, 100, 60, 1, 0, 1, "test"),
    DB.prepare(
      `INSERT INTO observers (observer_id, last_seen_iso, last_collection_ms, uptime_s,
                              schema_version, n_errors, is_healthy, binary_version)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).bind(OBS_Y, now, 100, 60, 1, 0, 1, "test"),

    // Both observers see DNA_A; only OBS_X sees DNA_B.
    DB.prepare(
      `INSERT INTO dnas_seen (observer_id, dna_b64, dna_tag, first_seen_iso, last_seen_iso, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind(OBS_X, DNA_A, "alpha", now, now, now),
    DB.prepare(
      `INSERT INTO dnas_seen (observer_id, dna_b64, dna_tag, first_seen_iso, last_seen_iso, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind(OBS_Y, DNA_A, "alpha", now, now, now),
    DB.prepare(
      `INSERT INTO dnas_seen (observer_id, dna_b64, dna_tag, first_seen_iso, last_seen_iso, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind(OBS_X, DNA_B, null, now, now, now),

    // AGENT_1 seen by both observers on DNA_A; canonical action count = MAX(100, 110) = 110.
    DB.prepare(
      `INSERT INTO agents_discovered (observer_id, dna_b64, agent_b64, agent_tag,
             first_seen_iso, last_seen_iso, action_count, warrants_issued, warrants_against, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).bind(OBS_X, DNA_A, AGENT_1, null, now, now, 100, 0, 0, now),
    DB.prepare(
      `INSERT INTO agents_discovered (observer_id, dna_b64, agent_b64, agent_tag,
             first_seen_iso, last_seen_iso, action_count, warrants_issued, warrants_against, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).bind(OBS_Y, DNA_A, AGENT_1, null, now, now, 110, 0, 0, now),

    // AGENT_2 only seen by OBS_X on DNA_A.
    DB.prepare(
      `INSERT INTO agents_discovered (observer_id, dna_b64, agent_b64, agent_tag,
             first_seen_iso, last_seen_iso, action_count, warrants_issued, warrants_against, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).bind(OBS_X, DNA_A, AGENT_2, null, now, now, 50, 0, 0, now),

    // AGENT_3 on DNA_B.
    DB.prepare(
      `INSERT INTO agents_discovered (observer_id, dna_b64, agent_b64, agent_tag,
             first_seen_iso, last_seen_iso, action_count, warrants_issued, warrants_against, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).bind(OBS_X, DNA_B, AGENT_3, null, now, now, 7, 0, 0, now),

    // Same warrant seen by both observers on DNA_A. DISTINCT dedup should make count = 1.
    DB.prepare(
      `INSERT INTO warrants (observer_id, dna_b64, op_hash_b64, warrant_type, author_b64,
             target_b64, ts_iso, first_seen_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(OBS_X, DNA_A, "op-1", "invalid_chain", AGENT_1, AGENT_2, now, now, now),
    DB.prepare(
      `INSERT INTO warrants (observer_id, dna_b64, op_hash_b64, warrant_type, author_b64,
             target_b64, ts_iso, first_seen_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(OBS_Y, DNA_A, "op-1", "invalid_chain", AGENT_1, AGENT_2, now, now, now),
  ]);
}

describe("DNA-scoped routes", () => {
  beforeAll(async () => {
    await applySchema();
    await seed();
  });

  it("GET /api/dnas returns per-DNA aggregates", async () => {
    const resp = await SELF.fetch("http://test/api/dnas");
    expect(resp.status).toBe(200);
    const { dnas } = await resp.json<{ dnas: Record<string, unknown>[] }>();
    expect(dnas.length).toBe(2);
    const alpha = dnas.find((d: Record<string, unknown>) => d.dna_b64 === DNA_A)!;
    expect(alpha.dna_tag).toBe("alpha");
    expect(alpha.observer_count).toBe(2);
    expect(alpha.agent_count).toBe(2);
    // AGENT_1 canonical = 110, AGENT_2 = 50.
    expect(alpha.total_actions).toBe(160);
    expect(alpha.warrant_count).toBe(1);
    const beta = dnas.find((d: Record<string, unknown>) => d.dna_b64 === DNA_B)!;
    expect(beta.observer_count).toBe(1);
    expect(beta.agent_count).toBe(1);
    expect(beta.total_actions).toBe(7);
    expect(beta.warrant_count).toBe(0);
  });

  it("GET /api/dnas/:dna/summary returns the tile numbers", async () => {
    const resp = await SELF.fetch(`http://test/api/dnas/${DNA_A}/summary`);
    expect(resp.status).toBe(200);
    const body = await resp.json<Record<string, unknown>>();
    expect(body.dna_b64).toBe(DNA_A);
    expect(body.agents).toBe(2);
    expect(body.total_actions).toBe(160);
    expect(body.warrants).toBe(1);
    expect(body.observers).toBe(2);
    expect(body.dna_tag).toBe("alpha");
  });

  it("GET /api/dnas/:dna/agents canonical collapses duplicate observers", async () => {
    const resp = await SELF.fetch(`http://test/api/dnas/${DNA_A}/agents`);
    expect(resp.status).toBe(200);
    const body = await resp.json<{ agents: Record<string, unknown>[]; per_observer: boolean }>();
    expect(body.per_observer).toBe(false);
    expect(body.agents.length).toBe(2);
    const a1 = body.agents.find((a: Record<string, unknown>) => a.agent_b64 === AGENT_1)!;
    expect(a1.action_count).toBe(110);
    expect(a1.observer_count).toBe(2);
    expect(a1.warrants_issued).toBe(1);
    const a2 = body.agents.find((a: Record<string, unknown>) => a.agent_b64 === AGENT_2)!;
    expect(a2.action_count).toBe(50);
    expect(a2.observer_count).toBe(1);
    expect(a2.warrants_against).toBe(1);
  });

  it("GET /api/dnas/:dna/agents?per_observer=1 returns one row per (observer, agent)", async () => {
    const resp = await SELF.fetch(
      `http://test/api/dnas/${DNA_A}/agents?per_observer=1`,
    );
    const body = await resp.json<{ agents: unknown[]; per_observer: boolean }>();
    expect(body.per_observer).toBe(true);
    expect(body.agents.length).toBe(3);
  });

  it("GET /api/dnas/:dna/observers returns per-DNA coverage", async () => {
    const resp = await SELF.fetch(`http://test/api/dnas/${DNA_A}/observers`);
    const body = await resp.json<{ observers: Record<string, unknown>[] }>();
    expect(body.observers.length).toBe(2);
    const x = body.observers.find((o: Record<string, unknown>) => o.observer_id === OBS_X)!;
    expect(x.agents_seen).toBe(2);
    expect(x.actions_reported).toBe(150);
    expect(x.is_healthy).toBe(1);
    const y = body.observers.find((o: Record<string, unknown>) => o.observer_id === OBS_Y)!;
    expect(y.agents_seen).toBe(1);
    expect(y.actions_reported).toBe(110);
  });

  it("GET /api/warrants?dna= filters to that DNA", async () => {
    const resp = await SELF.fetch(`http://test/api/warrants?dna=${DNA_B}`);
    const body = await resp.json<{ warrants: unknown[] }>();
    expect(body.warrants.length).toBe(0);
    const respA = await SELF.fetch(`http://test/api/warrants?dna=${DNA_A}`);
    const bodyA = await respA.json<{ warrants: unknown[] }>();
    expect(bodyA.warrants.length).toBe(2);
  });

  it("GET /api/diff?dna= scopes counts to that DNA", async () => {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const resp = await SELF.fetch(
      `http://test/api/diff?since=${encodeURIComponent(since)}&dna=${DNA_A}`,
    );
    const body = await resp.json<{ changed: Record<string, number> }>();
    expect(body.changed.agents_discovered).toBe(3);
    expect(body.changed.warrants).toBe(2);
  });
});
