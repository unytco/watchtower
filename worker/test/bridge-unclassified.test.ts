import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import schemaSql from "../src/schema.sql?raw";
import bridgeMigration from "../migrations/0002_bridge.sql?raw";
import unclassifiedMigration from "../migrations/0006_bridge_unclassified_streak.sql?raw";
import type { BridgeSelfHealth } from "../src/types";
import { applySql, bridgePayload, registerObserver, signedRequest } from "./helpers";

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
  await applySql(schemaSql, bridgeMigration, unclassifiedMigration);
  await registerObserver(OBSERVER_ID, SECRET_HEX);
}

/**
 * A reporter payload. Passing `undefined` for a streak field models a bridge
 * that predates it: the field is left out of the posted JSON.
 */
function payload(self_health: Partial<BridgeSelfHealth>) {
  return bridgePayload(OBSERVER_ID, DNA, new Date().toISOString(), { self_health });
}

async function ingestBridge(bodyObj: unknown): Promise<Response> {
  return SELF.fetch(await signedRequest("/ingest/bridge", OBSERVER_ID, SECRET_HEX, bodyObj));
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
      (await ingestBridge(payload({ unclassified_active: true, unclassified_consecutive: 2 })))
        .status,
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
