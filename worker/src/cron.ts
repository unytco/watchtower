import type { Env } from "./types";
import { evaluate } from "./alerts";

export async function scheduled(env: Env): Promise<void> {
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await env.DB.prepare("DELETE FROM ingest_nonces WHERE ts < ?").bind(tenMinAgo).run();

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare("DELETE FROM derived_metrics_ts WHERE bucket_hour_iso < ?")
    .bind(thirtyDaysAgo)
    .run();
  await env.DB.prepare("DELETE FROM bridge_throughput_ts WHERE bucket_hour_iso < ?")
    .bind(thirtyDaysAgo)
    .run();

  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare("DELETE FROM bridge_services WHERE last_seen_iso < ?")
    .bind(fourteenDaysAgo)
    .run();
  // A backlog row is rewritten only when its numbers change, so it expires
  // with its reporter's service row rather than by its own timestamps.
  await env.DB.prepare(
    `DELETE FROM bridge_backlog
      WHERE NOT EXISTS (SELECT 1 FROM bridge_services s WHERE s.observer_id = bridge_backlog.observer_id)`,
  ).run();

  await evaluate(env);
}
