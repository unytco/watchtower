import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import wipeTemplate from "../../scripts/wipe-dna.sql?raw";
import { evaluate } from "../src/alerts";

// DNA_B differs from DNA_A only where LIKE would not notice: A's `_` and the case of one letter.
const DNA_A = `hC0k${"x".repeat(23)}_Mixed-${"y".repeat(18)}`;
const DNA_B = `hC0k${"x".repeat(23)}zmixed-${"y".repeat(18)}`;
const OP_A = "op-hash-a";
const OP_B = "op-hash-b";
const LONG_AGO = "2000-01-01T00:00:00.000Z";

let serial = 0;

function wipeStatements(dna: string): string[] {
  return wipeTemplate
    .replaceAll("__DNA__", dna)
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("--"));
}

async function wipe(dna: string) {
  await env.DB.batch(wipeStatements(dna).map((sql) => env.DB.prepare(sql)));
}

async function appTables(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'
        AND name <> 'd1_migrations'
      ORDER BY name`,
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

async function dnaTables(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT m.name FROM sqlite_master m JOIN pragma_table_info(m.name) p
      WHERE m.type = 'table' AND p.name = 'dna_b64'
      ORDER BY m.name`,
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

/** Inserts one row, filling every column not in `values` with a unique placeholder. */
async function seedRow(table: string, values: Record<string, string | number>) {
  const { results: columns } = await env.DB.prepare("SELECT name, type FROM pragma_table_info(?)")
    .bind(table)
    .all<{ name: string; type: string }>();
  const row = columns.map(({ name, type }) =>
    name in values ? values[name] : type === "TEXT" ? `${table}.${name}.${serial++}` : 0,
  );
  await env.DB.prepare(
    `INSERT INTO ${table} (${columns.map((c) => c.name).join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  )
    .bind(...row)
    .run();
}

/**
 * One row of `dna` in every table with a dna_b64 column, plus a warrant seen by two
 * observers. Its expired chain lock and backlog bucket, with the warrant, trip the
 * alert rules, so `evaluate` writes entity keys in each DNA-bearing shape.
 */
async function seedDna(dna: string, opHash: string) {
  for (const table of await dnaTables()) {
    const values: Record<string, string | number> = { dna_b64: dna };
    if (table === "warrants") values.op_hash_b64 = opHash;
    if (table === "chain_locks") values.expires_at_iso = LONG_AGO;
    if (table === "derived_metrics_ts") values.pending_backlog = 1;
    await seedRow(table, values);
  }
  await seedRow("warrant_sightings", { op_hash_b64: opHash, observer_id: "obs-1" });
  await seedRow("warrant_sightings", { op_hash_b64: opHash, observer_id: "obs-2" });
  await evaluate(env);
}

async function snapshot(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of await appTables()) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all();
    out[table] = results.map((r) => JSON.stringify(r)).sort();
  }
  return out;
}

async function incidentKeysMentioning(dna: string, opHash: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT entity_key FROM alert_incidents WHERE instr(entity_key, ?) > 0 OR entity_key = ?",
  )
    .bind(dna, opHash)
    .all<{ entity_key: string }>();
  return results.map((r) => r.entity_key).sort();
}

describe("scripts/wipe-dna.sql", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });

  it("removes every row of the target DNA and leaves every other row as it was", async () => {
    for (const kind of [
      "new_warrant",
      "pending_backlog",
      "chain_lock_expired",
      "observer_silent",
    ]) {
      await seedRow("alert_rules", {
        kind,
        params_json: '{"threshold":0,"max_silent_minutes":1}',
        recipients_json: "[]",
        enabled: 1,
      });
    }
    for (const table of await appTables()) {
      if (table === "alert_rules" || table === "alert_incidents") continue;
      await seedRow(table, table === "observers" ? { last_seen_iso: LONG_AGO } : {});
    }
    await seedDna(DNA_B, OP_B);
    const withoutA = await snapshot();

    await seedDna(DNA_A, OP_A);
    const withA = await snapshot();
    for (const table of [...(await dnaTables()), "warrant_sightings"]) {
      expect(withA[table].length, table).toBeGreaterThan(withoutA[table].length);
    }
    expect(await incidentKeysMentioning(DNA_A, OP_A)).toHaveLength(3);

    await wipe(DNA_A);

    expect(await snapshot()).toEqual(withoutA);
    expect(await incidentKeysMentioning(DNA_B, OP_B)).toHaveLength(3);
  });

  it("has a DELETE for every table with a dna_b64 column", async () => {
    const targeted = wipeStatements(DNA_A).map((sql) => sql.split(" ")[2]);
    expect(targeted).toEqual(expect.arrayContaining(await dnaTables()));
  });

  it("keeps each statement on one line, the shape the script's preview is derived from", () => {
    for (const sql of wipeStatements(DNA_A)) {
      expect(sql).toMatch(/^DELETE FROM [a-z_]+ WHERE .+;$/);
    }
  });
});
