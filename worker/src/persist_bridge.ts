import type { Env, BridgePayload } from "./types";
import { hourlyBucket, upsertIfChanged } from "./write";

export async function persistBridge(env: Env, payload: BridgePayload): Promise<void> {
  const { observer_id, collected_at, dna_b64, self_health: h, backlog, throughput } = payload;
  const db = env.DB;

  await db.batch([
    // Setting an indexed column costs D1 an index write even when the value is
    // unchanged, so dna_b64 is written by the insert and moved here only when
    // it changes.
    ...["bridge_services", "bridge_backlog"].map((table) =>
      db
        .prepare(`UPDATE ${table} SET dna_b64 = ?1 WHERE observer_id = ?2 AND dna_b64 IS NOT ?1`)
        .bind(dna_b64, observer_id),
    ),
    upsertIfChanged(db, "bridge_services", {
      key: { observer_id },
      insertOnly: { dna_b64 },
      content: {
        last_seen_iso: collected_at,
        uptime_s: h.uptime_s,
        binary_version: h.binary_version,
        last_cycle_at_iso: h.last_cycle_at_iso ?? null,
        last_cycle_ms: h.last_cycle_ms ?? null,
        consecutive_failed_cycles: h.consecutive_failed_cycles,
        reconnect_failures_total: h.reconnect_failures_total,
        reconnects_ok_total: h.reconnects_ok_total,
        pressure_active: h.pressure_active ? 1 : 0,
        pressure_consecutive: h.pressure_consecutive,
        unclassified_active: h.unclassified_active ? 1 : 0,
        unclassified_consecutive: h.unclassified_consecutive ?? 0,
        stage_ejections_total: h.stage_ejections_total,
        is_stuck: h.is_stuck ? 1 : 0,
        last_error: h.last_error ?? null,
        last_error_at_iso: h.last_error_at_iso ?? null,
      },
      stamp: { updated_at: collected_at },
    }),
    upsertIfChanged(db, "bridge_backlog", {
      key: { observer_id },
      insertOnly: { dna_b64 },
      content: {
        detected: backlog.detected,
        queued: backlog.queued,
        claimed: backlog.claimed,
        in_flight: backlog.in_flight,
        succeeded_total: backlog.succeeded_total,
        failed_total: backlog.failed_total,
        oldest_queued_age_s: backlog.oldest_queued_age_s ?? null,
      },
      stamp: { collected_at, updated_at: collected_at },
    }),
    upsertIfChanged(db, "bridge_throughput_ts", {
      key: { observer_id, dna_b64, bucket_hour_iso: hourlyBucket(collected_at) },
      content: {
        succeeded: throughput.succeeded_1h,
        failed: throughput.failed_1h,
        avg_time_to_succeed_s: throughput.avg_time_to_succeed_s_24h ?? null,
      },
    }),
  ]);
}
