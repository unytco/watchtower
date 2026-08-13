import type { Env, BridgePayload } from "./types";

/**
 * Apply a verified bridge-service payload. Latest-state upserts for
 * `bridge_services` and `bridge_backlog`; the current hour's row in
 * `bridge_throughput_ts` is upserted with the rolling 1h counts so the
 * dashboard can render a smooth sparkline.
 */
export async function persistBridge(env: Env, payload: BridgePayload): Promise<void> {
  const { observer_id, collected_at, dna_b64, self_health, backlog, throughput } = payload;
  const bucket = hourlyBucket(collected_at);

  const batch: D1PreparedStatement[] = [];

  batch.push(
    env.DB.prepare(
      `INSERT INTO bridge_services (
         observer_id, dna_b64, last_seen_iso, uptime_s, binary_version,
         last_cycle_at_iso, last_cycle_ms,
         consecutive_failed_cycles, reconnect_failures_total, reconnects_ok_total,
         pressure_active, pressure_consecutive,
         unclassified_active, unclassified_consecutive, stage_ejections_total,
         is_stuck, last_error, last_error_at_iso, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(observer_id) DO UPDATE SET
         dna_b64 = excluded.dna_b64,
         last_seen_iso = excluded.last_seen_iso,
         uptime_s = excluded.uptime_s,
         binary_version = excluded.binary_version,
         last_cycle_at_iso = excluded.last_cycle_at_iso,
         last_cycle_ms = excluded.last_cycle_ms,
         consecutive_failed_cycles = excluded.consecutive_failed_cycles,
         reconnect_failures_total = excluded.reconnect_failures_total,
         reconnects_ok_total = excluded.reconnects_ok_total,
         pressure_active = excluded.pressure_active,
         pressure_consecutive = excluded.pressure_consecutive,
         unclassified_active = excluded.unclassified_active,
         unclassified_consecutive = excluded.unclassified_consecutive,
         stage_ejections_total = excluded.stage_ejections_total,
         is_stuck = excluded.is_stuck,
         last_error = excluded.last_error,
         last_error_at_iso = excluded.last_error_at_iso,
         updated_at = excluded.updated_at`,
    ).bind(
      observer_id,
      dna_b64,
      collected_at,
      self_health.uptime_s,
      self_health.binary_version,
      self_health.last_cycle_at_iso ?? null,
      self_health.last_cycle_ms ?? null,
      self_health.consecutive_failed_cycles,
      self_health.reconnect_failures_total,
      self_health.reconnects_ok_total,
      self_health.pressure_active ? 1 : 0,
      self_health.pressure_consecutive,
      self_health.unclassified_active ? 1 : 0,
      self_health.unclassified_consecutive ?? 0,
      self_health.stage_ejections_total,
      self_health.is_stuck ? 1 : 0,
      self_health.last_error ?? null,
      self_health.last_error_at_iso ?? null,
      collected_at,
    ),
  );

  batch.push(
    env.DB.prepare(
      `INSERT INTO bridge_backlog (
         observer_id, dna_b64, collected_at,
         detected, queued, claimed, in_flight,
         succeeded_total, failed_total, oldest_queued_age_s, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(observer_id) DO UPDATE SET
         dna_b64 = excluded.dna_b64,
         collected_at = excluded.collected_at,
         detected = excluded.detected,
         queued = excluded.queued,
         claimed = excluded.claimed,
         in_flight = excluded.in_flight,
         succeeded_total = excluded.succeeded_total,
         failed_total = excluded.failed_total,
         oldest_queued_age_s = excluded.oldest_queued_age_s,
         updated_at = excluded.updated_at`,
    ).bind(
      observer_id,
      dna_b64,
      collected_at,
      backlog.detected,
      backlog.queued,
      backlog.claimed,
      backlog.in_flight,
      backlog.succeeded_total,
      backlog.failed_total,
      backlog.oldest_queued_age_s ?? null,
      collected_at,
    ),
  );

  batch.push(
    env.DB.prepare(
      `INSERT INTO bridge_throughput_ts (
         observer_id, dna_b64, bucket_hour_iso,
         succeeded, failed, avg_time_to_succeed_s
       )
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(observer_id, dna_b64, bucket_hour_iso) DO UPDATE SET
         succeeded = excluded.succeeded,
         failed = excluded.failed,
         avg_time_to_succeed_s = excluded.avg_time_to_succeed_s`,
    ).bind(
      observer_id,
      dna_b64,
      bucket,
      throughput.succeeded_1h,
      throughput.failed_1h,
      throughput.avg_time_to_succeed_s_24h ?? null,
    ),
  );

  await env.DB.batch(batch);
}

function hourlyBucket(iso: string): string {
  const d = new Date(iso);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}
