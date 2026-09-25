import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import initMigration from "../migrations/0001_init.sql?raw";
import bridgeMigration from "../migrations/0002_bridge.sql?raw";
import noncesMigration from "../migrations/0007_ingest_nonces_without_rowid.sql?raw";
import schemaSql from "../src/schema.sql?raw";
import { scheduled } from "../src/cron";
import { applySql, meteredEnv } from "./helpers";

const INSERT_NONCE = "INSERT INTO ingest_nonces (nonce, observer_id, ts) VALUES (?, ?, ?)";
const TS = "2026-09-25T10:00:00.000Z";

async function meteredInsert(nonce: string): Promise<number> {
  const metered = meteredEnv();
  await metered.env.DB.prepare(INSERT_NONCE).bind(nonce, "observer", TS).run();
  return metered.rowsWritten();
}

describe("ingest_nonces", () => {
  it("0007 carries pending nonces across, still rejects a replay, and cuts an insert from three writes to one", async () => {
    await env.DB.exec("DROP TABLE IF EXISTS ingest_nonces;");
    await applySql(initMigration);
    expect(await meteredInsert("pending")).toBe(3);

    await applySql(noncesMigration);

    const { results } = await env.DB.prepare(
      "SELECT nonce, observer_id, ts FROM ingest_nonces",
    ).all();
    expect(results).toEqual([{ nonce: "pending", observer_id: "observer", ts: TS }]);
    await expect(
      env.DB.prepare(INSERT_NONCE).bind("pending", "observer", TS).run(),
    ).rejects.toThrow(/UNIQUE/);
    expect(await meteredInsert("fresh")).toBe(1);
  });

  it("the cron trims nonces older than the replay window and keeps fresh ones", async () => {
    await applySql(schemaSql, bridgeMigration);
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60 * 1000).toISOString();
    await env.DB.batch([
      env.DB.prepare(INSERT_NONCE).bind("stale", "observer", minutesAgo(20)),
      env.DB.prepare(INSERT_NONCE).bind("fresh", "observer", minutesAgo(1)),
    ]);

    await scheduled(env);

    const { results } = await env.DB.prepare("SELECT nonce FROM ingest_nonces").all();
    expect(results).toEqual([{ nonce: "fresh" }]);
  });
});
