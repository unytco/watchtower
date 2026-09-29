import { SELF, applyD1Migrations, createExecutionContext, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { upsertIfChanged } from "../src/write";
import schemaSql from "../src/schema.sql?raw";
import type { CapGrantSummary } from "../src/types";
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

function grant(tag: string, fields: Partial<CapGrantSummary> = {}): CapGrantSummary {
  return {
    app_id: "",
    cell_b64: "",
    tag,
    function_count: 1,
    access_type: "Unrestricted",
    ...fields,
  };
}

const SAME_TAG = [
  grant("by_progenitor", { action_hash_b64: "grant-1", function_count: 1 }),
  grant("by_progenitor", { action_hash_b64: "grant-2", function_count: 2 }),
];
const WITHOUT_HASH = [grant("alpha"), grant("beta")];

async function post(collected_at: string, ...grantsPerDna: CapGrantSummary[][]): Promise<number> {
  const metered = meteredEnv();
  const payload = observerPayload(OBSERVER_ID, collected_at, {
    dnas: grantsPerDna.map((cap_grants, i) => dnaSnapshot(`${DNA}-${i}`, { cap_grants })),
  });
  const resp = await worker.fetch(
    await signedRequest("/ingest", OBSERVER_ID, SECRET_HEX, payload),
    metered.env,
    createExecutionContext(),
  );
  expect(resp.status).toBe(200);
  return metered.rowsWritten();
}

/** Rows a post writes when nothing changed: its nonce and the observer's and each DNA's last-seen. */
async function repeatPostWrites(dnas = 1): Promise<number> {
  const noGrants = Array.from({ length: dnas }, (): CapGrantSummary[] => []);
  await post(T1, ...noGrants);
  return post(T2, ...noGrants);
}

async function rows(): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare(
    `SELECT action_hash_b64, tag, function_count, updated_at FROM cap_grants_by_action
      ORDER BY action_hash_b64, tag`,
  ).all();
  return results;
}

describe("cap_grants_by_action", () => {
  beforeAll(async () => {
    await applySql(schemaSql);
    await registerObserver(OBSERVER_ID, SECRET_HEX);
  });

  it("stores grants that share a tag as one row each, one write apiece, and rewrites neither on a repeat post", async () => {
    const liveness = await repeatPostWrites();

    expect(await post(T3, SAME_TAG)).toBe(liveness + 2);
    const stored = [
      { action_hash_b64: "grant-1", tag: "by_progenitor", function_count: 1, updated_at: T3 },
      { action_hash_b64: "grant-2", tag: "by_progenitor", function_count: 2, updated_at: T3 },
    ];
    expect(await rows()).toEqual(stored);

    expect(await post(T4, SAME_TAG)).toBe(liveness);
    expect(await rows()).toEqual(stored);
  });

  it("keeps one row per tag for an observer that predates the action hash", async () => {
    const liveness = await repeatPostWrites();

    await post(T3, WITHOUT_HASH);
    const stored = [
      { action_hash_b64: "", tag: "alpha", function_count: 1, updated_at: T3 },
      { action_hash_b64: "", tag: "beta", function_count: 1, updated_at: T3 },
    ];
    expect(await rows()).toEqual(stored);

    expect(await post(T4, WITHOUT_HASH)).toBe(liveness);
    expect(await rows()).toEqual(stored);
  });
});

function oldWorkerWrite(
  tag: string,
  function_count: number,
  updated_at: string,
  observer_id = OBSERVER_ID,
) {
  return upsertIfChanged(env.DB, "cap_grants", {
    key: { observer_id, app_id: "", cell_b64: "", tag },
    content: { function_count, access_type: "Unrestricted" },
    stamp: { updated_at },
  }).run();
}

async function legacyRows(): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT tag, function_count FROM cap_grants").all();
  return results;
}

async function changedGrants(since: string): Promise<number> {
  const resp = await SELF.fetch(
    `http://test/api/diff?since=${encodeURIComponent(since)}&observer_id=${OBSERVER_ID}`,
  );
  const { changed } = await resp.json<{ changed: Record<string, number> }>();
  return changed.cap_grants;
}

describe("migration 0008", () => {
  const applyPendingMigrations = () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

  beforeAll(async () => {
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS.filter((m) => m.name < "0008"),
    );
    await registerObserver(OBSERVER_ID, SECRET_HEX);
  });

  it("carries a cap_grants row over under the key an observer without the hash posts to, so /diff counts it once", async () => {
    await oldWorkerWrite("by_progenitor", 1, T1);

    await applyPendingMigrations();

    expect(await changedGrants(T1)).toBe(1);
    expect(await rows()).toEqual([
      { action_hash_b64: "", tag: "by_progenitor", function_count: 1, updated_at: T1 },
    ]);

    await post(T2, [grant("by_progenitor")]);
    expect(await changedGrants(T2)).toBe(0);

    await post(T3, [grant("by_progenitor", { function_count: 2 })]);
    expect(await changedGrants(T3)).toBe(1);

    await post(T4, []);
    expect(await changedGrants(T1)).toBe(1);
  });

  it("drops the carried row for each tag an observer posts with its hash, so /diff counts each grant once", async () => {
    const liveness = await repeatPostWrites(2);
    for (const tag of ["by_progenitor", "", "unposted"]) await oldWorkerWrite(tag, 1, T1);
    await oldWorkerWrite("by_progenitor", 1, T1, "other-observer");
    const inSecondDna = [grant("", { tag: null, action_hash_b64: "untagged" })];

    await applyPendingMigrations();
    expect(await post(T3, SAME_TAG, inSecondDna)).toBe(liveness + 3 + 2);

    const { results } = await env.DB.prepare(
      "SELECT observer_id, action_hash_b64, tag FROM cap_grants_by_action ORDER BY 1, 2, 3",
    ).all();
    expect(results).toEqual([
      { observer_id: OBSERVER_ID, action_hash_b64: "", tag: "unposted" },
      { observer_id: OBSERVER_ID, action_hash_b64: "grant-1", tag: "by_progenitor" },
      { observer_id: OBSERVER_ID, action_hash_b64: "grant-2", tag: "by_progenitor" },
      { observer_id: OBSERVER_ID, action_hash_b64: "untagged", tag: "" },
      { observer_id: "other-observer", action_hash_b64: "", tag: "by_progenitor" },
    ]);
    expect(await changedGrants(T1)).toBe(4);

    expect(await post(T4, SAME_TAG, inSecondDna)).toBe(liveness);
  });

  it("carries a NULL tag over as '' and keeps the newest of rows that differ only in app_id or cell_b64", async () => {
    await env.DB.batch(
      [
        { tag: null, app_id: "", cell_b64: "", function_count: 1, updated_at: T1 },
        { tag: "x", app_id: "", cell_b64: "", function_count: 1, updated_at: T1 },
        { tag: "x", app_id: "app", cell_b64: "cell", function_count: 2, updated_at: T2 },
      ].map(({ tag, app_id, cell_b64, function_count, updated_at }) =>
        env.DB.prepare(
          `INSERT INTO cap_grants
             (observer_id, app_id, cell_b64, tag, function_count, access_type, updated_at)
           VALUES (?, ?, ?, ?, ?, 'Unrestricted', ?)`,
        ).bind(OBSERVER_ID, app_id, cell_b64, tag, function_count, updated_at),
      ),
    );

    await applyPendingMigrations();

    expect(await rows()).toEqual([
      { action_hash_b64: "", tag: "", function_count: 1, updated_at: T1 },
      { action_hash_b64: "", tag: "x", function_count: 2, updated_at: T2 },
    ]);
  });

  it("leaves cap_grants to a Worker that predates it, and /diff catches up on the next post", async () => {
    await oldWorkerWrite("by_progenitor", 1, T1);

    await applyPendingMigrations();
    expect(await legacyRows()).toEqual([{ tag: "by_progenitor", function_count: 1 }]);

    await oldWorkerWrite("by_progenitor", 2, T2);
    expect(await legacyRows()).toEqual([{ tag: "by_progenitor", function_count: 2 }]);
    expect(await changedGrants(T2)).toBe(0);

    await post(T3, [grant("by_progenitor", { function_count: 2 })]);
    expect(await changedGrants(T2)).toBe(1);
  });
});
