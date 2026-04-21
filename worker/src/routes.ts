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

routes.get("/summary", async (c) => {
  const observerId = c.req.query("observer_id");
  const rows = await c.env.DB.batch([
    bindOptional(
      c.env.DB.prepare(
        `SELECT COUNT(*) AS c FROM agents_discovered ${observerId ? "WHERE observer_id = ?" : ""}`,
      ),
      observerId,
    ),
    bindOptional(
      c.env.DB.prepare(
        `SELECT COUNT(*) AS c FROM warrants ${observerId ? "WHERE observer_id = ?" : ""}`,
      ),
      observerId,
    ),
    bindOptional(
      c.env.DB.prepare(
        `SELECT COUNT(*) AS c FROM dnas_seen ${observerId ? "WHERE observer_id = ?" : ""}`,
      ),
      observerId,
    ),
  ]);
  return c.json({
    observer_id: observerId,
    agents: rowCount(rows[0]),
    warrants: rowCount(rows[1]),
    dnas: rowCount(rows[2]),
  });
});

routes.get("/agents", async (c) => {
  const observerId = c.req.query("observer_id");
  const dna = c.req.query("dna");
  const limit = Number(c.req.query("limit") ?? 200);
  let sql = `SELECT * FROM agents_discovered WHERE 1=1`;
  const binds: unknown[] = [];
  if (observerId) {
    sql += ` AND observer_id = ?`;
    binds.push(observerId);
  }
  if (dna) {
    sql += ` AND dna_b64 = ?`;
    binds.push(dna);
  }
  sql += ` ORDER BY action_count DESC LIMIT ?`;
  binds.push(limit);
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json({ agents: results });
});

routes.get("/dnas", async (c) => {
  const observerId = c.req.query("observer_id");
  let sql = `SELECT observer_id, dna_b64, dna_tag, first_seen_iso, last_seen_iso FROM dnas_seen`;
  const binds: unknown[] = [];
  if (observerId) {
    sql += ` WHERE observer_id = ?`;
    binds.push(observerId);
  }
  sql += ` ORDER BY last_seen_iso DESC LIMIT 500`;
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json({ dnas: results });
});

routes.get("/warrants", async (c) => {
  const observerId = c.req.query("observer_id");
  const limit = Number(c.req.query("limit") ?? 200);
  let sql = `SELECT * FROM warrants`;
  const binds: unknown[] = [];
  if (observerId) {
    sql += ` WHERE observer_id = ?`;
    binds.push(observerId);
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
  if (!since) return c.text("missing ?since=ISO", 400);

  const table = c.req.query("table");
  if (table) {
    return diffOne(c, table, since, observerId);
  }
  const tables = [
    "agents_discovered",
    "warrants",
    "chain_locks",
    "validation_coverage",
    "cap_grants",
    "scheduled_functions",
    "blocks",
    "apps",
  ];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const r = await countSince(c.env, t, since, observerId);
    out[t] = r;
  }
  return c.json({ since, observer_id: observerId, changed: out });
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

routes.get("/analysis", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, kind, computed_at, result_json FROM analysis_runs
     ORDER BY computed_at DESC LIMIT 50`,
  ).all();
  return c.json({ analysis: results });
});

function bindOptional(stmt: D1PreparedStatement, val?: string): D1PreparedStatement {
  return val ? stmt.bind(val) : stmt;
}

function rowCount(r: D1Result): number {
  const first = (r.results?.[0] ?? {}) as { c?: number };
  return first.c ?? 0;
}

async function diffOne(
  c: { env: Env; json: (value: unknown) => Response },
  table: string,
  since: string,
  observerId?: string,
): Promise<Response> {
  const count = await countSince(c.env, table, since, observerId);
  return c.json({ table, since, observer_id: observerId, changed: count });
}

async function countSince(
  env: Env,
  table: string,
  since: string,
  observerId?: string,
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
  const row = await env.DB.prepare(sql)
    .bind(...binds)
    .first<{ c: number }>();
  return row?.c ?? 0;
}
