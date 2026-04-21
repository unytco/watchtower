import type { Env } from "./types";
import { evaluate } from "./alerts";

/// The cron runs every 5 minutes. Responsibilities:
///   1. Trim `ingest_nonces` older than 10 minutes.
///   2. Trim `derived_metrics_ts` older than 30 days.
///   3. Recompute cross-observer analysis rows (warrant agreement etc).
///   4. Evaluate alert rules and fire incidents.
export async function scheduled(env: Env): Promise<void> {
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await env.DB.prepare("DELETE FROM ingest_nonces WHERE ts < ?")
    .bind(tenMinAgo)
    .run();

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare("DELETE FROM derived_metrics_ts WHERE bucket_hour_iso < ?")
    .bind(thirtyDaysAgo)
    .run();

  await recomputeCrossObserver(env);
  await evaluate(env);
}

async function recomputeCrossObserver(env: Env): Promise<void> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const { results: sightings } = await env.DB.prepare(
    `SELECT op_hash_b64, COUNT(DISTINCT observer_id) AS observers
     FROM warrant_sightings
     GROUP BY op_hash_b64
     ORDER BY observers DESC
     LIMIT 100`,
  ).all<{ op_hash_b64: string; observers: number }>();

  await env.DB.prepare(
    `INSERT INTO analysis_runs (id, kind, computed_at, result_json) VALUES (?, 'warrant_sightings', ?, ?)`,
  )
    .bind(id, now, JSON.stringify(sightings))
    .run();
}
