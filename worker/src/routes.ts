import { Hono } from "hono";
import type { Env } from "./types";

export const routes = new Hono<{ Bindings: Env }>();

routes.get("/observers", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT observer_id, last_seen_iso, last_collection_ms, uptime_s, schema_version,
            n_errors, is_healthy, binary_version
     FROM observers ORDER BY observer_id ASC`,
  ).all();
  return c.json({ observers: results });
});

// Per-DNA list for the home page. One row per dna_b64, with aggregates across
// every observer that has ever reported that DNA. `total_actions` is the sum
// of each agent's MAX(action_count) so observers that disagree on a single
// agent's count only contribute once.
routes.get("/dnas", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT d.dna_b64,
            MAX(COALESCE(dt.name, d.dna_tag))                       AS dna_tag,
            COUNT(DISTINCT d.observer_id)                           AS observer_count,
            (SELECT COUNT(DISTINCT agent_b64)
               FROM agents_discovered a
              WHERE a.dna_b64 = d.dna_b64)                          AS agent_count,
            (SELECT COALESCE(SUM(ac), 0) FROM (
                SELECT MAX(action_count) AS ac
                  FROM agents_discovered a
                 WHERE a.dna_b64 = d.dna_b64
                 GROUP BY agent_b64
             ))                                                     AS total_actions,
            (SELECT COUNT(DISTINCT op_hash_b64)
               FROM warrants w
              WHERE w.dna_b64 = d.dna_b64)                          AS warrant_count,
            MAX(d.last_seen_iso)                                    AS last_activity_iso,
            MIN(d.first_seen_iso)                                   AS first_seen_iso
       FROM dnas_seen d
  LEFT JOIN dna_tags dt ON dt.dna_b64 = d.dna_b64
      GROUP BY d.dna_b64
      ORDER BY last_activity_iso DESC
      LIMIT 500`,
  ).all();
  return c.json({ dnas: results });
});

// Per-DNA tile numbers.
routes.get("/dnas/:dna/summary", async (c) => {
  const dna = c.req.param("dna");
  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(DISTINCT agent_b64) FROM agents_discovered WHERE dna_b64 = ?1)             AS agents,
       (SELECT COALESCE(SUM(ac), 0) FROM (
            SELECT MAX(action_count) AS ac
              FROM agents_discovered
             WHERE dna_b64 = ?1
             GROUP BY agent_b64))                                                               AS total_actions,
       (SELECT COUNT(DISTINCT op_hash_b64) FROM warrants WHERE dna_b64 = ?1)                    AS warrants,
       (SELECT COUNT(DISTINCT observer_id) FROM dnas_seen WHERE dna_b64 = ?1)                   AS observers,
       (SELECT MAX(last_seen_iso) FROM dnas_seen WHERE dna_b64 = ?1)                            AS last_activity_iso,
       (SELECT MAX(COALESCE(dt.name, ds.dna_tag))
          FROM dnas_seen ds
     LEFT JOIN dna_tags dt ON dt.dna_b64 = ds.dna_b64
         WHERE ds.dna_b64 = ?1)                                                                 AS dna_tag`,
  )
    .bind(dna)
    .first<{
      agents: number;
      total_actions: number;
      warrants: number;
      observers: number;
      last_activity_iso: string | null;
      dna_tag: string | null;
    }>();
  return c.json({ dna_b64: dna, ...(row ?? {}) });
});

// Per-DNA agents. Two shapes:
// - default (canonical): one row per agent_b64. action_count = MAX across
//   observers so two observers reporting the same agent don't double-count.
//   warrants_issued / warrants_against come from DISTINCT op_hash_b64 in the
//   warrants table to avoid double-counting across observers.
// - ?per_observer=1: one row per (observer_id, agent_b64). Useful for
//   spotting disagreements between observers.
routes.get("/dnas/:dna/agents", async (c) => {
  const dna = c.req.param("dna");
  const perObserver = c.req.query("per_observer") === "1";
  const limit = Number(c.req.query("limit") ?? 500);

  if (perObserver) {
    const { results } = await c.env.DB.prepare(
      `SELECT a.observer_id,
              a.dna_b64,
              a.agent_b64,
              a.agent_tag,
              a.first_seen_iso,
              a.last_seen_iso,
              a.action_count,
              a.warrants_issued,
              a.warrants_against
         FROM agents_discovered a
        WHERE a.dna_b64 = ?1
        ORDER BY a.action_count DESC
        LIMIT ?2`,
    )
      .bind(dna, limit)
      .all();
    return c.json({ agents: results, per_observer: true });
  }

  const { results } = await c.env.DB.prepare(
    `SELECT a.agent_b64,
            MAX(COALESCE(at.name, a.agent_tag))                          AS agent_tag,
            MAX(a.action_count)                                          AS action_count,
            COUNT(DISTINCT a.observer_id)                                AS observer_count,
            MIN(a.first_seen_iso)                                        AS first_seen_iso,
            MAX(a.last_seen_iso)                                         AS last_seen_iso,
            (SELECT COUNT(DISTINCT op_hash_b64) FROM warrants w
               WHERE w.dna_b64 = a.dna_b64 AND w.author_b64 = a.agent_b64) AS warrants_issued,
            (SELECT COUNT(DISTINCT op_hash_b64) FROM warrants w
               WHERE w.dna_b64 = a.dna_b64 AND w.target_b64 = a.agent_b64) AS warrants_against
       FROM agents_discovered a
  LEFT JOIN agent_tags at ON at.observer_id = a.observer_id AND at.pubkey_b64 = a.agent_b64
      WHERE a.dna_b64 = ?1
      GROUP BY a.agent_b64
      ORDER BY action_count DESC
      LIMIT ?2`,
  )
    .bind(dna, limit)
    .all();
  return c.json({ agents: results, per_observer: false });
});

// Per-DNA observer list with DNA-scoped coverage plus each observer's global
// health snapshot.
routes.get("/dnas/:dna/observers", async (c) => {
  const dna = c.req.param("dna");
  const { results } = await c.env.DB.prepare(
    `SELECT d.observer_id,
            o.is_healthy,
            o.n_errors,
            o.last_seen_iso                                               AS observer_last_seen,
            o.binary_version,
            d.first_seen_iso                                              AS dna_first_seen,
            d.last_seen_iso                                               AS dna_last_seen,
            (SELECT COUNT(DISTINCT agent_b64) FROM agents_discovered a
               WHERE a.dna_b64 = d.dna_b64 AND a.observer_id = d.observer_id) AS agents_seen,
            (SELECT COALESCE(SUM(action_count), 0) FROM agents_discovered a
               WHERE a.dna_b64 = d.dna_b64 AND a.observer_id = d.observer_id) AS actions_reported
       FROM dnas_seen d
  LEFT JOIN observers o ON o.observer_id = d.observer_id
      WHERE d.dna_b64 = ?
      ORDER BY d.last_seen_iso DESC`,
  )
    .bind(dna)
    .all();
  return c.json({ observers: results });
});

// Bridge-service reporter view for a DNA. Returns empty arrays when the
// DNA has no registered bridge reporter, so the dashboard can hide the
// panel without 404 handling.
routes.get("/dnas/:dna/bridge", async (c) => {
  const dna = c.req.param("dna");
  const hours = Number(c.req.query("hours") ?? 24);
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  const servicesQ = c.env.DB.prepare(
    `SELECT observer_id, dna_b64, last_seen_iso, uptime_s, binary_version,
            last_cycle_at_iso, last_cycle_ms,
            consecutive_failed_cycles, reconnect_failures_total, reconnects_ok_total,
            pressure_active, pressure_consecutive, stage_ejections_total,
            is_stuck, last_error, last_error_at_iso, updated_at
       FROM bridge_services
      WHERE dna_b64 = ?
      ORDER BY last_seen_iso DESC`,
  ).bind(dna);
  const backlogQ = c.env.DB.prepare(
    `SELECT observer_id, dna_b64, collected_at,
            detected, queued, claimed, in_flight,
            succeeded_total, failed_total, oldest_queued_age_s, updated_at
       FROM bridge_backlog
      WHERE dna_b64 = ?
      ORDER BY collected_at DESC`,
  ).bind(dna);
  const throughputQ = c.env.DB.prepare(
    `SELECT observer_id, dna_b64, bucket_hour_iso,
            succeeded, failed, avg_time_to_succeed_s
       FROM bridge_throughput_ts
      WHERE dna_b64 = ? AND bucket_hour_iso >= ?
      ORDER BY bucket_hour_iso ASC`,
  ).bind(dna, since);

  const [services, backlog, throughput] = await Promise.all([
    servicesQ.all(),
    backlogQ.all(),
    throughputQ.all(),
  ]);

  return c.json({
    services: services.results,
    backlog: backlog.results,
    throughput: throughput.results,
  });
});

routes.get("/warrants", async (c) => {
  const observerId = c.req.query("observer_id");
  const dna = c.req.query("dna");
  const limit = Number(c.req.query("limit") ?? 200);
  let sql = `SELECT * FROM warrants WHERE 1=1`;
  const binds: unknown[] = [];
  if (observerId) {
    sql += ` AND observer_id = ?`;
    binds.push(observerId);
  }
  if (dna) {
    sql += ` AND dna_b64 = ?`;
    binds.push(dna);
  }
  sql += ` ORDER BY ts_iso DESC LIMIT ?`;
  binds.push(limit);
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json({ warrants: results });
});

routes.get("/metrics", async (c) => {
  const observerId = c.req.query("observer_id");
  const dna = c.req.query("dna");
  const hours = Number(c.req.query("hours") ?? 24);
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  let sql = `SELECT * FROM derived_metrics_ts WHERE bucket_hour_iso >= ?`;
  const binds: unknown[] = [since];
  if (observerId) {
    sql += ` AND observer_id = ?`;
    binds.push(observerId);
  }
  if (dna) {
    sql += ` AND dna_b64 = ?`;
    binds.push(dna);
  }
  sql += ` ORDER BY bucket_hour_iso ASC`;
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json({ metrics: results });
});

routes.get("/diff", async (c) => {
  const since = c.req.query("since");
  const observerId = c.req.query("observer_id");
  const dna = c.req.query("dna");
  if (!since) return c.text("missing ?since=ISO", 400);

  const table = c.req.query("table");
  if (table) {
    return diffOne(c, table, since, observerId, dna);
  }
  const tables = [
    // DNA-scoped (filtered by ?dna= when provided)
    "dnas_seen",
    "agents_discovered",
    "warrants",
    "chain_locks",
    "validation_coverage",
    "scheduled_functions",
    "slice_hashes",
    "chain_summaries",
    // Node-scoped (no dna_b64 column; count is for the whole observer)
    "cap_grants",
    "blocks",
    "apps",
  ];
  const out: Record<string, number> = {};
  for (const t of tables) {
    out[t] = await countSince(c.env, t, since, observerId, dna);
  }
  return c.json({ since, observer_id: observerId, dna_b64: dna, changed: out });
});

routes.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ results: [] });
  const like = `%${q}%`;
  const { results } = await c.env.DB.prepare(
    `SELECT 'agent' AS kind, agent_b64 AS hash, dna_b64, observer_id, agent_tag AS tag
       FROM agents_discovered WHERE agent_b64 LIKE ? OR agent_tag LIKE ?
     UNION ALL
     SELECT 'warrant', op_hash_b64, dna_b64, observer_id, NULL
       FROM warrants WHERE op_hash_b64 LIKE ? OR author_b64 LIKE ? OR target_b64 LIKE ?
     UNION ALL
     SELECT 'dna', dna_b64, dna_b64, observer_id, dna_tag
       FROM dnas_seen WHERE dna_b64 LIKE ? OR dna_tag LIKE ?
     LIMIT 100`,
  )
    .bind(like, like, like, like, like, like, like)
    .all();
  return c.json({ results });
});

routes.get("/alerts/rules", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, kind, params_json, recipients_json, enabled, created_at FROM alert_rules`,
  ).all();
  return c.json({ rules: results });
});

routes.post("/alerts/rules", async (c) => {
  const body = await c.req.json<{
    kind: string;
    params?: Record<string, unknown>;
    recipients: string[];
    enabled?: boolean;
  }>();
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO alert_rules (id, kind, params_json, recipients_json, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      body.kind,
      JSON.stringify(body.params ?? {}),
      JSON.stringify(body.recipients),
      body.enabled === false ? 0 : 1,
      new Date().toISOString(),
    )
    .run();
  return c.json({ id });
});

routes.get("/alerts/incidents", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, rule_id, entity_key, fired_at, resolved_at, last_notified_at, state
     FROM alert_incidents ORDER BY fired_at DESC LIMIT 500`,
  ).all();
  return c.json({ incidents: results });
});

routes.post("/alerts/incidents/:id/resolve", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare(
    `UPDATE alert_incidents SET state = 'resolved', resolved_at = ? WHERE id = ?`,
  )
    .bind(new Date().toISOString(), id)
    .run();
  return c.json({ ok: true });
});

async function diffOne(
  c: { env: Env; json: (value: unknown) => Response },
  table: string,
  since: string,
  observerId?: string,
  dna?: string,
): Promise<Response> {
  const count = await countSince(c.env, table, since, observerId, dna);
  return c.json({ table, since, observer_id: observerId, dna_b64: dna, changed: count });
}

async function countSince(
  env: Env,
  table: string,
  since: string,
  observerId?: string,
  dna?: string,
): Promise<number> {
  const allowed = new Set([
    "agents_discovered",
    "warrants",
    "chain_locks",
    "validation_coverage",
    "cap_grants",
    "scheduled_functions",
    "blocks",
    "apps",
    "dnas_seen",
    "slice_hashes",
    "chain_summaries",
  ]);
  if (!allowed.has(table)) return 0;
  let sql = `SELECT COUNT(*) AS c FROM ${table} WHERE updated_at >= ?`;
  const binds: unknown[] = [since];
  if (observerId) {
    sql += ` AND observer_id = ?`;
    binds.push(observerId);
  }
  // Some tables (cap_grants, blocks, apps) have no dna_b64 column, so we only
  // apply the DNA filter when the table actually carries one.
  const tablesWithoutDna = new Set(["cap_grants", "blocks", "apps"]);
  if (dna && !tablesWithoutDna.has(table)) {
    sql += ` AND dna_b64 = ?`;
    binds.push(dna);
  }
  const row = await env.DB.prepare(sql)
    .bind(...binds)
    .first<{ c: number }>();
  return row?.c ?? 0;
}
