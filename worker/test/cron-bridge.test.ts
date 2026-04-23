import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import schemaSql from "../src/schema.sql?raw";
import bridgeMigration from "../migrations/0002_bridge.sql?raw";
import { scheduled } from "../src/cron";

// Apply both the base schema and the bridge migration into the
// Miniflare D1 instance. The base schema matches the reusable helper
// in `ingest.test.ts`; we just tack on the bridge tables so `cron`
// has somewhere to trim.
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
}

const OBS_FRESH = "bridge-fresh";
const OBS_STALE = "bridge-stale";
const DNA = "dna-bridge";

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function seed() {
  const nowIso = new Date().toISOString();
  const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const twentyDaysAgo = isoDaysAgo(20);
  const fortyDaysAgo = isoDaysAgo(40);

  // Two services: one reporting recently, one silent > 14d.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO bridge_services (observer_id, dna_b64, last_seen_iso, uptime_s, binary_version, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind(OBS_FRESH, DNA, fourHoursAgo, 3600, "test", fourHoursAgo),
    env.DB.prepare(
      `INSERT INTO bridge_services (observer_id, dna_b64, last_seen_iso, uptime_s, binary_version, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind(OBS_STALE, DNA, twentyDaysAgo, 0, "test", twentyDaysAgo),

    env.DB.prepare(
      `INSERT INTO bridge_backlog (observer_id, dna_b64, collected_at, detected, queued, claimed, in_flight,
                                   succeeded_total, failed_total, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).bind(OBS_FRESH, DNA, fourHoursAgo, 0, 1, 0, 0, 0, 0, fourHoursAgo),
    env.DB.prepare(
      `INSERT INTO bridge_backlog (observer_id, dna_b64, collected_at, detected, queued, claimed, in_flight,
                                   succeeded_total, failed_total, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).bind(OBS_STALE, DNA, twentyDaysAgo, 0, 0, 0, 0, 0, 0, twentyDaysAgo),

    // Throughput: one fresh bucket, one > 30d bucket (to be trimmed).
    env.DB.prepare(
      `INSERT INTO bridge_throughput_ts (observer_id, dna_b64, bucket_hour_iso, succeeded, failed)
       VALUES (?,?,?,?,?)`,
    ).bind(OBS_FRESH, DNA, nowIso, 3, 0),
    env.DB.prepare(
      `INSERT INTO bridge_throughput_ts (observer_id, dna_b64, bucket_hour_iso, succeeded, failed)
       VALUES (?,?,?,?,?)`,
    ).bind(OBS_FRESH, DNA, fortyDaysAgo, 1, 0),
  ]);
}

describe("scheduled cron bridge trims", () => {
  beforeEach(async () => {
    // Clean slate between cases so the alert/cross-observer side
    // effects from `scheduled` don't leak state.
    await env.DB.exec("DROP TABLE IF EXISTS bridge_services;");
    await env.DB.exec("DROP TABLE IF EXISTS bridge_backlog;");
    await env.DB.exec("DROP TABLE IF EXISTS bridge_throughput_ts;");
    await applySchema();
    await seed();
  });

  it("drops stale bridge_services rows older than 14 days", async () => {
    await scheduled(env);
    const { results } = await env.DB.prepare(
      "SELECT observer_id FROM bridge_services ORDER BY observer_id",
    ).all<{ observer_id: string }>();
    expect(results.map((r) => r.observer_id)).toEqual([OBS_FRESH]);
  });

  it("drops stale bridge_backlog rows older than 14 days", async () => {
    await scheduled(env);
    const { results } = await env.DB.prepare(
      "SELECT observer_id FROM bridge_backlog ORDER BY observer_id",
    ).all<{ observer_id: string }>();
    expect(results.map((r) => r.observer_id)).toEqual([OBS_FRESH]);
  });

  it("drops bridge_throughput_ts buckets older than 30 days but keeps fresh ones", async () => {
    await scheduled(env);
    const { results } = await env.DB.prepare(
      "SELECT bucket_hour_iso FROM bridge_throughput_ts",
    ).all<{ bucket_hour_iso: string }>();
    expect(results).toHaveLength(1);
    // Fresh bucket is within a few ms of now; just assert it's not the
    // 40-day-old ISO string.
    expect(results[0].bucket_hour_iso.startsWith(new Date().toISOString().slice(0, 10))).toBe(true);
  });
});
