import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import schemaSql from "../src/schema.sql?raw";
import type { DerivedMetrics } from "../src/types";
import { applySql, dnaSnapshot, observerPayload, registerObserver, signedRequest } from "./helpers";

// B107: a degraded observer read posts `null` for a derived metric, not a
// misleading 0. This proves the null survives ingest (the column is nullable as
// of migration 0005) and is served back as null by `/api/metrics`, so the
// dashboard can render it distinctly from a DNA that genuinely sits at zero.

const SECRET_HEX = "c".repeat(64);
const OBSERVER_ID = "degraded-observer";
const DNA_DEGRADED = "dna-degraded";
const DNA_IDLE = "dna-idle";

async function applySchema() {
  await applySql(schemaSql);
  await registerObserver(OBSERVER_ID, SECRET_HEX);
}

function payload(dna_b64: string, derived_metrics: DerivedMetrics) {
  return observerPayload(OBSERVER_ID, new Date().toISOString(), {
    dnas: [dnaSnapshot(dna_b64, { derived_metrics })],
  });
}

async function ingest(bodyObj: unknown) {
  return SELF.fetch(await signedRequest("/ingest", OBSERVER_ID, SECRET_HEX, bodyObj));
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
