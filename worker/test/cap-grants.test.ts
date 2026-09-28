import { createExecutionContext, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { upsertIfChanged } from "../src/write";
import capGrantsMigration from "../migrations/0008_cap_grants_by_action.sql?raw";
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

async function post(collected_at: string, cap_grants: CapGrantSummary[]): Promise<number> {
  const metered = meteredEnv();
  const payload = observerPayload(OBSERVER_ID, collected_at, {
    dnas: [dnaSnapshot(DNA, { cap_grants })],
  });
  const resp = await worker.fetch(
    await signedRequest("/ingest", OBSERVER_ID, SECRET_HEX, payload),
    metered.env,
    createExecutionContext(),
  );
  expect(resp.status).toBe(200);
  return metered.rowsWritten();
}

/** Rows a post writes when nothing changed: its nonce and the observer's and DNA's last-seen. */
async function repeatPostWrites(): Promise<number> {
  await post(T1, []);
  return post(T2, []);
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

  it("0008 leaves cap_grants writable on its old key for a Worker that predates it", async () => {
    await env.DB.exec("DROP TABLE cap_grants_by_action;");
    const oldWorkerUpsert = (function_count: number) =>
      upsertIfChanged(env.DB, "cap_grants", {
        key: { observer_id: OBSERVER_ID, app_id: "", cell_b64: "", tag: "by_progenitor" },
        content: { function_count, access_type: "Unrestricted" },
        stamp: { updated_at: T1 },
      }).run();
    await oldWorkerUpsert(1);

    await applySql(capGrantsMigration);

    await oldWorkerUpsert(2);
    const { results } = await env.DB.prepare("SELECT tag, function_count FROM cap_grants").all();
    expect(results).toEqual([{ tag: "by_progenitor", function_count: 2 }]);

    await post(T2, SAME_TAG);
    expect((await rows()).map((r) => r.action_hash_b64)).toEqual(["grant-1", "grant-2"]);
  });
});
