import { SELF, applyD1Migrations, createExecutionContext, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import schemaSql from "../src/schema.sql?raw";
import type { CapGrantSummary, Env } from "../src/types";
import {
  applySql,
  dnaSnapshot,
  meteredEnv,
  observerPayload,
  registerObserver,
  signedRequest,
} from "./helpers";

const SECRET_HEX = "f".repeat(64);
const OBSERVER_ID = "grant-observer";
const DNA = "dna-grants";

// All within one hour, so every post shares the DNA's hourly metrics row.
const T1 = "2026-09-28T10:00:00.000Z";
const T2 = "2026-09-28T10:05:00.000Z";
const T3 = "2026-09-28T10:10:00.000Z";
const T4 = "2026-09-28T10:15:00.000Z";

function grant(action_hash_b64: string, fields: Partial<CapGrantSummary> = {}): CapGrantSummary {
  return {
    app_id: "",
    cell_b64: "",
    action_hash_b64,
    tag: "by_progenitor",
    function_count: 1,
    access_type: "Unrestricted",
    ...fields,
  };
}

const GRANTS = [
  grant("grant-1"),
  grant("grant-2", { function_count: 2 }),
  grant("untagged", { tag: null }),
];

function stored(updated_at: string) {
  return [
    { action_hash_b64: "grant-1", tag: "by_progenitor", function_count: 1, updated_at },
    { action_hash_b64: "grant-2", tag: "by_progenitor", function_count: 2, updated_at },
    { action_hash_b64: "untagged", tag: null, function_count: 1, updated_at },
  ];
}

async function send(collected_at: string, dbEnv: Env, ...grantsPerDna: CapGrantSummary[][]) {
  const payload = observerPayload(OBSERVER_ID, collected_at, {
    dnas: grantsPerDna.map((cap_grants, i) => dnaSnapshot(`${DNA}-${i}`, { cap_grants })),
  });
  return worker.fetch(
    await signedRequest("/ingest", OBSERVER_ID, SECRET_HEX, payload),
    dbEnv,
    createExecutionContext(),
  );
}

/** Rows the post wrote. */
async function post(collected_at: string, ...grantsPerDna: CapGrantSummary[][]): Promise<number> {
  const metered = meteredEnv();
  const resp = await send(collected_at, metered.env, ...grantsPerDna);
  expect(resp.status).toBe(200);
  return metered.rowsWritten();
}

async function repeatPostWrites(): Promise<number> {
  await post(T1, []);
  return post(T2, []);
}

async function rows(): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare(
    `SELECT action_hash_b64, tag, function_count, updated_at FROM cap_grants
      ORDER BY action_hash_b64`,
  ).all();
  return results;
}

async function changedGrants(since: string): Promise<number> {
  const resp = await SELF.fetch(
    `http://test/api/diff?since=${encodeURIComponent(since)}&observer_id=${OBSERVER_ID}`,
  );
  const { changed } = await resp.json<{ changed: Record<string, number> }>();
  return changed.cap_grants;
}

describe("cap_grants", () => {
  beforeAll(async () => {
    await applySql(schemaSql);
    await registerObserver(OBSERVER_ID, SECRET_HEX);
  });

  it("stores grants that share a tag as one row each, one write apiece, and rewrites none on a repeat post", async () => {
    const liveness = await repeatPostWrites();

    expect(await post(T3, GRANTS)).toBe(liveness + 3);
    expect(await rows()).toEqual(stored(T3));
    expect(await changedGrants(T3)).toBe(3);

    expect(await post(T4, GRANTS)).toBe(liveness);
    expect(await rows()).toEqual(stored(T3));
    expect(await changedGrants(T4)).toBe(0);
  });

  it("updates a grant whose tag or function count changed in place, and leaves the others alone", async () => {
    const liveness = await repeatPostWrites();
    await post(T3, GRANTS);

    const changed = [
      grant("grant-1", { tag: "renamed" }),
      grant("grant-2", { function_count: 3 }),
      grant("grant-3"),
      grant("untagged", { tag: null }),
    ];
    expect(await post(T4, changed)).toBe(liveness + 3);

    expect(await rows()).toEqual([
      { action_hash_b64: "grant-1", tag: "renamed", function_count: 1, updated_at: T4 },
      { action_hash_b64: "grant-2", tag: "by_progenitor", function_count: 3, updated_at: T4 },
      { action_hash_b64: "grant-3", tag: "by_progenitor", function_count: 1, updated_at: T4 },
      { action_hash_b64: "untagged", tag: null, function_count: 1, updated_at: T3 },
    ]);
    expect(await changedGrants(T4)).toBe(3);
  });

  it("rejects a post holding a grant without action_hash_b64 with a 400 that names the field, and stores no grant or observer row", async () => {
    const { action_hash_b64: _, ...unhashed } = grant("");

    const resp = await send(T3, env, GRANTS, [unhashed as CapGrantSummary]);

    expect(resp.status).toBe(400);
    expect(await resp.text()).toBe(`dna ${DNA}-1 has a cap grant without action_hash_b64`);
    expect(await rows()).toEqual([]);
    const observers = await env.DB.prepare("SELECT observer_id FROM observers").all();
    expect(observers.results).toEqual([]);
  });
});

describe("migration 0008", () => {
  beforeAll(async () => {
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS.filter((m) => m.name < "0008"),
    );
    await registerObserver(OBSERVER_ID, SECRET_HEX);
  });

  it("rebuilds cap_grants keyed by action hash, dropping the rows keyed by tag", async () => {
    await env.DB.prepare(
      `INSERT INTO cap_grants
         (observer_id, app_id, cell_b64, tag, function_count, access_type, updated_at)
       VALUES (?, '', '', 'by_progenitor', 1, 'Unrestricted', ?)`,
    )
      .bind(OBSERVER_ID, T1)
      .run();

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    expect(await rows()).toEqual([]);
    const liveness = await repeatPostWrites();
    expect(await post(T3, GRANTS)).toBe(liveness + 3);
    expect(await rows()).toEqual(stored(T3));
  });
});
