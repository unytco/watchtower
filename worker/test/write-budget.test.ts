import { createExecutionContext, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { scheduled } from "../src/cron";
import schemaSql from "../src/schema.sql?raw";
import bridgeMigration from "../migrations/0002_bridge.sql?raw";
import unclassifiedMigration from "../migrations/0006_bridge_unclassified_streak.sql?raw";
import type { AgentSummary, BridgePayload, DnaSnapshot, IngestPayload } from "../src/types";
import {
  applySql,
  bridgePayload,
  dnaSnapshot,
  meteredEnv,
  observerPayload,
  registerObserver,
  signedRequest,
} from "./helpers";

const SECRET_HEX = "e".repeat(64);
const OBSERVER_ID = "budget-observer";
const SECOND_OBSERVER_ID = "budget-observer-2";
const REPORTER_ID = "budget-bridge";
const DNA = "dna-budget";
const OTHER_DNA = "dna-budget-next";

const T1 = "2026-09-25T10:00:00.000Z";
const T2 = "2026-09-25T10:05:00.000Z";
const T3 = "2026-09-25T10:10:00.000Z";

// A repeat observer post still writes its replay nonce, the observer's
// last-seen, the DNA's last-seen, and one last-seen per reported agent.
const REPEAT_OBSERVER_POST_WRITES = 1 + 1 + 1 + 2;
// A repeat bridge post still writes its replay nonce and the service row.
const REPEAT_BRIDGE_POST_WRITES = 1 + 1;

const DEGRADED = {
  integration_rate: null,
  lag_p50_ms: null,
  lag_p99_ms: null,
  pending_backlog: null,
};

// The collector stamps an agent's first and last seen with the collection time
// on every cycle, and a chain summary's first and last timestamps likewise.
function agent(agent_b64: string, collected_at: string, fields: Partial<AgentSummary> = {}) {
  return {
    agent_b64,
    agent_tag: null,
    first_seen_iso: collected_at,
    last_seen_iso: collected_at,
    action_count: 5,
    warrants_issued: 0,
    warrants_against: 1,
    chain_closed: false,
    opening_summary_present: false,
    ...fields,
  };
}

/** Every per-DNA table the observer feeds, so a repeat post exercises each upsert. */
function dna(collected_at: string, fields: Partial<DnaSnapshot> = {}): DnaSnapshot {
  return dnaSnapshot(DNA, {
    dna_tag: "budget",
    dna_definition: { zomes: [], properties_summary_json: "{}", network_seed: null },
    agents: [agent("agent-a", collected_at), agent("agent-b", collected_at)],
    warrants: [
      {
        op_hash_b64: "op-warrant",
        warrant_type: "ChainIntegrity",
        author_b64: "agent-a",
        target_b64: "agent-b",
        ts_iso: T1,
        authored_ts_iso: T1,
        integrated_ts_iso: null,
        validation_status: null,
        signature_b64: "sig",
        proof_summary: { kind: "Other", description: "test" },
      },
    ],
    chain_summaries: ["agent-a", "agent-b"].map((agent_b64) => ({
      agent_b64,
      action_count: 5,
      first_ts_iso: collected_at,
      last_ts_iso: collected_at,
    })),
    slice_hashes: [0, 1, 2].map((slice_index) => ({
      arc_start: 0,
      arc_end: 100,
      slice_index,
      hash_b64: `slice-${slice_index}`,
    })),
    chain_locks: [{ author_b64: "agent-a", subject_b64: "subject", expires_at_iso: T3 }],
    scheduled_functions: [
      { author_b64: "agent-a", zome: "z", fn_name: "tick", scheduled_at_iso: T3 },
    ],
    validation_coverage: [
      { op_hash_b64: "op-1", receipt_count: 1 },
      { op_hash_b64: "op-2", receipt_count: 2 },
    ],
    cap_grants: [
      { app_id: "", cell_b64: "", tag: "grant", function_count: 2, access_type: "Transferable" },
    ],
    derived_metrics: { integration_rate: 0.5, lag_p50_ms: 10, lag_p99_ms: 20, pending_backlog: 0 },
    ...fields,
  });
}

function snapshot(collected_at: string, fields: Partial<DnaSnapshot> = {}): IngestPayload {
  return observerPayload(OBSERVER_ID, collected_at, {
    dnas: [dna(collected_at, fields)],
    apps: [{ app_id: "app", happ_name: "happ", role_name: "role", clone_of_app_id: null }],
    blocks: [{ target_id: "peer", reason: "test", start_iso: T1, end_iso: T3 }],
  });
}

/** POST through the worker with a metered D1, returning the rows it wrote and read. */
async function post(
  path: "/ingest" | "/ingest/bridge",
  observerId: string,
  body: IngestPayload | BridgePayload,
): Promise<{ written: number; read: number }> {
  const metered = meteredEnv();
  const resp = await worker.fetch(
    await signedRequest(path, observerId, SECRET_HEX, body),
    metered.env,
    createExecutionContext(),
  );
  expect(resp.status).toBe(200);
  return { written: metered.rowsWritten(), read: metered.rowsRead() };
}

async function written(
  path: "/ingest" | "/ingest/bridge",
  observerId: string,
  body: IngestPayload | BridgePayload,
): Promise<number> {
  return (await post(path, observerId, body)).written;
}

async function changedSince(since: string): Promise<Record<string, number>> {
  const resp = await SELF.fetch(`http://test/api/diff?since=${since}&dna=${DNA}`);
  const { changed } = await resp.json<{ changed: Record<string, number> }>();
  return Object.fromEntries(Object.entries(changed).filter(([, c]) => c > 0));
}

async function perObserverAgents(): Promise<Record<string, Record<string, unknown>>> {
  const resp = await SELF.fetch(`http://test/api/dnas/${DNA}/agents?per_observer=1`);
  const { agents } = await resp.json<{ agents: Record<string, unknown>[] }>();
  return Object.fromEntries(agents.map((a) => [a.agent_b64 as string, a]));
}

async function row(sql: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare(sql).first();
}

async function bridge(dna: string) {
  const resp = await SELF.fetch(`http://test/api/dnas/${dna}/bridge`);
  return resp.json<{
    services: Record<string, unknown>[];
    backlog: Record<string, unknown>[];
    throughput: Record<string, unknown>[];
  }>();
}

describe("D1 write budget", () => {
  beforeAll(async () => {
    await applySql(schemaSql, bridgeMigration, unclassifiedMigration);
    for (const id of [OBSERVER_ID, SECOND_OBSERVER_ID, REPORTER_ID]) {
      await registerObserver(id, SECRET_HEX);
    }
  });

  it("a repeat observer post writes only its liveness rows", async () => {
    expect(await written("/ingest", OBSERVER_ID, snapshot(T1))).toBeGreaterThan(
      REPEAT_OBSERVER_POST_WRITES,
    );

    expect(await written("/ingest", OBSERVER_ID, snapshot(T2))).toBe(REPEAT_OBSERVER_POST_WRITES);

    // Unchanged rows keep their updated_at; only the DNA's liveness row moved.
    expect(await changedSince(T2)).toEqual({ dnas_seen: 1 });

    const agents = await perObserverAgents();
    expect(agents["agent-a"]).toMatchObject({ first_seen_iso: T1, last_seen_iso: T2 });
    expect(agents["agent-b"]).toMatchObject({ first_seen_iso: T1, last_seen_iso: T2 });
    const { observers } = await (
      await SELF.fetch(`http://test/api/dnas/${DNA}/observers`)
    ).json<{ observers: Record<string, unknown>[] }>();
    expect(observers[0]).toMatchObject({
      observer_last_seen: T2,
      dna_first_seen: T1,
      dna_last_seen: T2,
    });
  });

  it("a changed row is still rewritten, and only that row", async () => {
    await post("/ingest", OBSERVER_ID, snapshot(T1));
    await post("/ingest", OBSERVER_ID, snapshot(T2));

    const changed = snapshot(T3);
    const d = changed.node.dnas[0];
    d.slice_hashes[0].hash_b64 = "slice-0-moved";
    d.validation_coverage[1].receipt_count = 3;
    expect(await written("/ingest", OBSERVER_ID, changed)).toBe(REPEAT_OBSERVER_POST_WRITES + 2);

    expect(await changedSince(T3)).toEqual({
      dnas_seen: 1,
      slice_hashes: 1,
      validation_coverage: 1,
    });
    expect(
      await row(`SELECT hash_b64, updated_at FROM slice_hashes WHERE slice_index = 0`),
    ).toEqual({ hash_b64: "slice-0-moved", updated_at: T3 });
    expect(
      await row(
        `SELECT receipt_count, updated_at FROM validation_coverage WHERE op_hash_b64 = 'op-2'`,
      ),
    ).toEqual({ receipt_count: 3, updated_at: T3 });
  });

  it("every content table takes a change, including from NULL to a value", async () => {
    await post("/ingest", OBSERVER_ID, snapshot(T1, { derived_metrics: DEGRADED }));

    const changed = snapshot(T2);
    const d = changed.node.dnas[0];
    d.dna_definition!.network_seed = "seed";
    d.warrants[0].validation_status = "Valid";
    d.warrants[0].integrated_ts_iso = T2;
    d.chain_summaries[0].action_count = 6;
    d.chain_locks[0].expires_at_iso = T2;
    d.scheduled_functions[0].scheduled_at_iso = T2;
    d.cap_grants[0].function_count = 3;
    changed.node.apps[0].happ_name = "happ-2";
    changed.node.blocks[0].end_iso = T2;
    await post("/ingest", OBSERVER_ID, changed);

    expect(await changedSince(T2)).toEqual({
      dnas_seen: 1,
      warrants: 1,
      chain_summaries: 1,
      chain_locks: 1,
      scheduled_functions: 1,
      cap_grants: 1,
      apps: 1,
      blocks: 1,
    });
    expect(
      await row("SELECT validation_status, integrated_ts_iso, first_seen_at FROM warrants"),
    ).toEqual({ validation_status: "Valid", integrated_ts_iso: T2, first_seen_at: T1 });
    expect(await row("SELECT network_seed, updated_at FROM dna_definitions")).toEqual({
      network_seed: "seed",
      updated_at: T2,
    });
    expect(await row("SELECT integration_rate, pending_backlog FROM derived_metrics_ts")).toEqual({
      integration_rate: 0.5,
      pending_backlog: 0,
    });
  });

  it("an agent whose counts change is rewritten; its unchanged peer only moves last-seen", async () => {
    await post("/ingest", OBSERVER_ID, snapshot(T1));
    await post(
      "/ingest",
      OBSERVER_ID,
      snapshot(T2, { agents: [agent("agent-a", T2, { action_count: 6 }), agent("agent-b", T2)] }),
    );

    expect(await changedSince(T2)).toEqual({ dnas_seen: 1, agents_discovered: 1 });
    const agents = await perObserverAgents();
    expect(agents["agent-a"]).toMatchObject({
      action_count: 6,
      first_seen_iso: T1,
      last_seen_iso: T2,
    });
    expect(agents["agent-b"]).toMatchObject({ action_count: 5, last_seen_iso: T2 });
  });

  it("a latched migration flag reported false again is not a change", async () => {
    const closed = [agent("agent-a", T1, { chain_closed: true }), agent("agent-b", T1)];
    await post("/ingest", OBSERVER_ID, snapshot(T1, { agents: closed }));

    const transientMiss = [agent("agent-a", T2), agent("agent-b", T2)];
    expect(await written("/ingest", OBSERVER_ID, snapshot(T2, { agents: transientMiss }))).toBe(
      REPEAT_OBSERVER_POST_WRITES,
    );
    expect(await changedSince(T2)).toEqual({ dnas_seen: 1 });
    expect((await perObserverAgents())["agent-a"].chain_closed).toBe(1);
  });

  it("a latched flag reported false stays set when the same post changes the agent", async () => {
    const closed = [agent("agent-a", T1, { chain_closed: true }), agent("agent-b", T1)];
    await post("/ingest", OBSERVER_ID, snapshot(T1, { agents: closed }));

    const missAndGrow = [agent("agent-a", T2, { action_count: 6 }), agent("agent-b", T2)];
    await post("/ingest", OBSERVER_ID, snapshot(T2, { agents: missAndGrow }));

    expect((await perObserverAgents())["agent-a"]).toMatchObject({
      action_count: 6,
      chain_closed: 1,
    });
  });

  it("an agent's last-seen moves only for the observer and DNA that reported it", async () => {
    const other = dnaSnapshot(OTHER_DNA, { agents: [agent("agent-a", T1)] });
    await post(
      "/ingest",
      OBSERVER_ID,
      observerPayload(OBSERVER_ID, T1, { dnas: [dna(T1), other] }),
    );
    await post(
      "/ingest",
      SECOND_OBSERVER_ID,
      observerPayload(SECOND_OBSERVER_ID, T1, { dnas: [dna(T1)] }),
    );

    await post("/ingest", OBSERVER_ID, observerPayload(OBSERVER_ID, T2, { dnas: [dna(T2)] }));

    const { results } = await env.DB.prepare(
      `SELECT observer_id, dna_b64, last_seen_iso FROM agents_discovered
        WHERE agent_b64 = 'agent-a' ORDER BY observer_id, dna_b64`,
    ).all();
    expect(results).toEqual([
      { observer_id: OBSERVER_ID, dna_b64: DNA, last_seen_iso: T2 },
      { observer_id: OBSERVER_ID, dna_b64: OTHER_DNA, last_seen_iso: T1 },
      { observer_id: SECOND_OBSERVER_ID, dna_b64: DNA, last_seen_iso: T1 },
    ]);
  });

  it("a repeat post's reads grow linearly with the agents it reports", async () => {
    const AGENTS = 100;
    const fleet = (at: string) => Array.from({ length: AGENTS }, (_, i) => agent(`agent-${i}`, at));
    await post("/ingest", OBSERVER_ID, snapshot(T1, { agents: fleet(T1) }));

    const { read } = await post("/ingest", OBSERVER_ID, snapshot(T2, { agents: fleet(T2) }));
    expect(read).toBeLessThan(5 * AGENTS);
  });

  it("a repeat bridge post writes only the service row", async () => {
    await post("/ingest/bridge", REPORTER_ID, bridgePayload(REPORTER_ID, DNA, T1));
    const repeat = bridgePayload(REPORTER_ID, DNA, T2, { self_health: { uptime_s: 420 } });
    expect(await written("/ingest/bridge", REPORTER_ID, repeat)).toBe(REPEAT_BRIDGE_POST_WRITES);

    const { services, backlog } = await bridge(DNA);
    expect(services[0]).toMatchObject({ last_seen_iso: T2, uptime_s: 420 });
    expect(backlog[0]).toMatchObject({ collected_at: T2, updated_at: T1, queued: 0 });
  });

  it("a bridge post with new numbers rewrites the backlog and throughput rows", async () => {
    await post("/ingest/bridge", REPORTER_ID, bridgePayload(REPORTER_ID, DNA, T1));
    const busier = bridgePayload(REPORTER_ID, DNA, T2, {
      backlog: { queued: 1 },
      throughput: { succeeded_1h: 4 },
    });
    expect(await written("/ingest/bridge", REPORTER_ID, busier)).toBe(
      REPEAT_BRIDGE_POST_WRITES + 2,
    );

    const { backlog } = await bridge(DNA);
    expect(backlog[0]).toMatchObject({ collected_at: T2, updated_at: T2, queued: 1 });
    expect(await row("SELECT succeeded FROM bridge_throughput_ts")).toEqual({ succeeded: 4 });
  });

  it("a reporter that moves to another DNA takes its service and backlog rows along", async () => {
    await post("/ingest/bridge", REPORTER_ID, bridgePayload(REPORTER_ID, DNA, T1));
    await post("/ingest/bridge", REPORTER_ID, bridgePayload(REPORTER_ID, OTHER_DNA, T2));

    const before = await bridge(DNA);
    expect(before.services).toHaveLength(0);
    expect(before.backlog).toHaveLength(0);
    const after = await bridge(OTHER_DNA);
    expect(after.services).toHaveLength(1);
    expect(after.backlog).toHaveLength(1);
  });

  it("a cron tick with nothing expired writes nothing", async () => {
    await post("/ingest", OBSERVER_ID, snapshot(new Date().toISOString()));
    const metered = meteredEnv();
    await scheduled(metered.env);
    expect(metered.rowsWritten()).toBe(0);
  });
});
