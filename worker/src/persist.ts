import type { Env, IngestPayload, DnaSnapshot } from "./types";

/// Apply a verified ingest payload by upserting into the latest-state tables
/// and appending to the hourly timeseries.
export async function persist(env: Env, payload: IngestPayload, rawBytes: number): Promise<void> {
  const { observer_id, collected_at, self_health, node } = payload;

  const batch: D1PreparedStatement[] = [];

  batch.push(
    env.DB.prepare(
      `INSERT INTO observers (observer_id, last_seen_iso, last_collection_ms, uptime_s,
                              schema_version, n_errors, is_healthy, binary_version)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(observer_id) DO UPDATE SET
         last_seen_iso = excluded.last_seen_iso,
         last_collection_ms = excluded.last_collection_ms,
         uptime_s = excluded.uptime_s,
         schema_version = excluded.schema_version,
         n_errors = excluded.n_errors,
         is_healthy = 1,
         binary_version = excluded.binary_version`,
    ).bind(
      observer_id,
      collected_at,
      self_health.last_collection_ms,
      self_health.uptime_s,
      payload.schema_version,
      self_health.n_errors_this_cycle,
      self_health.binary_version,
    ),
  );

  batch.push(
    env.DB.prepare(
      "INSERT OR REPLACE INTO snapshots (observer_id, collected_at, schema_version, bytes) VALUES (?, ?, ?, ?)",
    ).bind(observer_id, collected_at, payload.schema_version, rawBytes),
  );

  for (const app of node.apps) {
    batch.push(
      env.DB.prepare(
        `INSERT INTO apps (observer_id, app_id, happ_name, role_name, clone_of_app_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(observer_id, app_id) DO UPDATE SET
           happ_name = excluded.happ_name,
           role_name = excluded.role_name,
           clone_of_app_id = excluded.clone_of_app_id,
           updated_at = excluded.updated_at`,
      ).bind(
        observer_id,
        app.app_id,
        app.happ_name,
        app.role_name,
        app.clone_of_app_id ?? null,
        collected_at,
      ),
    );
  }

  for (const block of node.blocks) {
    batch.push(
      env.DB.prepare(
        `INSERT INTO blocks (observer_id, target_id, reason, start_iso, end_iso, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(observer_id, target_id, start_iso) DO UPDATE SET
           reason = excluded.reason,
           end_iso = excluded.end_iso,
           updated_at = excluded.updated_at`,
      ).bind(
        observer_id,
        block.target_id,
        block.reason,
        block.start_iso,
        block.end_iso,
        collected_at,
      ),
    );
  }

  for (const d of node.dnas) {
    pushDna(env, batch, observer_id, collected_at, d);
  }

  await env.DB.batch(batch);
}

function pushDna(
  env: Env,
  batch: D1PreparedStatement[],
  observer_id: string,
  collected_at: string,
  d: DnaSnapshot,
): void {
  batch.push(
    env.DB.prepare(
      `INSERT INTO dnas_seen (observer_id, dna_b64, dna_tag, first_seen_iso, last_seen_iso, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(observer_id, dna_b64) DO UPDATE SET
         dna_tag = excluded.dna_tag,
         last_seen_iso = excluded.last_seen_iso,
         updated_at = excluded.updated_at`,
    ).bind(
      observer_id,
      d.dna_b64,
      d.dna_tag ?? null,
      collected_at,
      collected_at,
      collected_at,
    ),
  );

  if (d.dna_definition) {
    batch.push(
      env.DB.prepare(
        `INSERT INTO dna_definitions (observer_id, dna_b64, zomes_json, properties_json, network_seed, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(observer_id, dna_b64) DO UPDATE SET
           zomes_json = excluded.zomes_json,
           properties_json = excluded.properties_json,
           network_seed = excluded.network_seed,
           updated_at = excluded.updated_at`,
      ).bind(
        observer_id,
        d.dna_b64,
        JSON.stringify(d.dna_definition.zomes),
        d.dna_definition.properties_summary_json,
        d.dna_definition.network_seed ?? null,
        collected_at,
      ),
    );
  }

  for (const a of d.agents) {
    batch.push(
      env.DB.prepare(
        `INSERT INTO agents_discovered (observer_id, dna_b64, agent_b64, agent_tag,
                                        first_seen_iso, last_seen_iso,
                                        action_count, warrants_issued, warrants_against, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(observer_id, dna_b64, agent_b64) DO UPDATE SET
           agent_tag = excluded.agent_tag,
           last_seen_iso = excluded.last_seen_iso,
           action_count = excluded.action_count,
           warrants_issued = excluded.warrants_issued,
           warrants_against = excluded.warrants_against,
           updated_at = excluded.updated_at`,
      ).bind(
        observer_id,
        d.dna_b64,
        a.agent_b64,
        a.agent_tag ?? null,
        a.first_seen_iso,
        a.last_seen_iso,
        a.action_count,
        a.warrants_issued,
        a.warrants_against,
        collected_at,
      ),
    );
  }

  for (const w of d.warrants) {
    const proofJson = w.proof_summary
      ? JSON.stringify(w.proof_summary)
      : null;
    batch.push(
      env.DB.prepare(
        `INSERT INTO warrants (observer_id, dna_b64, op_hash_b64, warrant_type,
                              author_b64, target_b64, ts_iso, first_seen_at, updated_at,
                              authored_ts_iso, integrated_ts_iso, validation_status,
                              signature_b64, proof_summary_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(observer_id, op_hash_b64) DO UPDATE SET
           warrant_type = excluded.warrant_type,
           authored_ts_iso = excluded.authored_ts_iso,
           integrated_ts_iso = excluded.integrated_ts_iso,
           validation_status = excluded.validation_status,
           signature_b64 = excluded.signature_b64,
           proof_summary_json = excluded.proof_summary_json,
           updated_at = excluded.updated_at`,
      ).bind(
        observer_id,
        d.dna_b64,
        w.op_hash_b64,
        w.warrant_type,
        w.author_b64,
        w.target_b64,
        w.ts_iso,
        collected_at,
        collected_at,
        w.authored_ts_iso ?? null,
        w.integrated_ts_iso ?? null,
        w.validation_status ?? null,
        w.signature_b64 ?? null,
        proofJson,
      ),
    );
    batch.push(
      env.DB.prepare(
        `INSERT INTO warrant_sightings (op_hash_b64, observer_id, last_seen_at) VALUES (?, ?, ?)
         ON CONFLICT(op_hash_b64, observer_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      ).bind(w.op_hash_b64, observer_id, collected_at),
    );
  }

  for (const cs of d.chain_summaries) {
    batch.push(
      env.DB.prepare(
        `INSERT INTO chain_summaries (observer_id, dna_b64, agent_b64, action_count,
                                      first_ts_iso, last_ts_iso, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(observer_id, dna_b64, agent_b64) DO UPDATE SET
           action_count = excluded.action_count,
           last_ts_iso = excluded.last_ts_iso,
           updated_at = excluded.updated_at`,
      ).bind(
        observer_id,
        d.dna_b64,
        cs.agent_b64,
        cs.action_count,
        cs.first_ts_iso,
        cs.last_ts_iso,
        collected_at,
      ),
    );
  }

  for (const s of d.slice_hashes) {
    batch.push(
      env.DB.prepare(
        `INSERT INTO slice_hashes (observer_id, dna_b64, arc_start, arc_end, slice_index, hash_b64, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(observer_id, dna_b64, arc_start, arc_end, slice_index) DO UPDATE SET
           hash_b64 = excluded.hash_b64,
           updated_at = excluded.updated_at`,
      ).bind(
        observer_id,
        d.dna_b64,
        s.arc_start,
        s.arc_end,
        s.slice_index,
        s.hash_b64,
        collected_at,
      ),
    );
  }

  for (const l of d.chain_locks) {
    batch.push(
      env.DB.prepare(
        `INSERT INTO chain_locks (observer_id, dna_b64, author_b64, subject_b64, expires_at_iso, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(observer_id, dna_b64, author_b64, subject_b64) DO UPDATE SET
           expires_at_iso = excluded.expires_at_iso,
           updated_at = excluded.updated_at`,
      ).bind(observer_id, d.dna_b64, l.author_b64, l.subject_b64, l.expires_at_iso, collected_at),
    );
  }

  for (const f of d.scheduled_functions) {
    batch.push(
      env.DB.prepare(
        `INSERT INTO scheduled_functions (observer_id, dna_b64, author_b64, zome, fn_name, scheduled_at_iso, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(observer_id, dna_b64, author_b64, zome, fn_name) DO UPDATE SET
           scheduled_at_iso = excluded.scheduled_at_iso,
           updated_at = excluded.updated_at`,
      ).bind(
        observer_id,
        d.dna_b64,
        f.author_b64,
        f.zome,
        f.fn_name,
        f.scheduled_at_iso,
        collected_at,
      ),
    );
  }

  for (const c of d.validation_coverage) {
    batch.push(
      env.DB.prepare(
        `INSERT INTO validation_coverage (observer_id, dna_b64, op_hash_b64, receipt_count, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(observer_id, dna_b64, op_hash_b64) DO UPDATE SET
           receipt_count = excluded.receipt_count,
           updated_at = excluded.updated_at`,
      ).bind(observer_id, d.dna_b64, c.op_hash_b64, c.receipt_count, collected_at),
    );
  }

  for (const g of d.cap_grants) {
    batch.push(
      env.DB.prepare(
        `INSERT INTO cap_grants (observer_id, app_id, cell_b64, tag, function_count, access_type, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(observer_id, app_id, cell_b64, tag) DO UPDATE SET
           function_count = excluded.function_count,
           access_type = excluded.access_type,
           updated_at = excluded.updated_at`,
      ).bind(
        observer_id,
        g.app_id,
        g.cell_b64,
        g.tag ?? "",
        g.function_count,
        g.access_type,
        collected_at,
      ),
    );
  }

  // Hourly timeseries bucket.
  const bucket = hourlyBucket(collected_at);
  batch.push(
    env.DB.prepare(
      `INSERT INTO derived_metrics_ts (observer_id, dna_b64, bucket_hour_iso,
                                       integration_rate, lag_p50_ms, lag_p99_ms, pending_backlog)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(observer_id, dna_b64, bucket_hour_iso) DO UPDATE SET
         integration_rate = excluded.integration_rate,
         lag_p50_ms = excluded.lag_p50_ms,
         lag_p99_ms = excluded.lag_p99_ms,
         pending_backlog = excluded.pending_backlog`,
    ).bind(
      observer_id,
      d.dna_b64,
      bucket,
      d.derived_metrics.integration_rate,
      d.derived_metrics.lag_p50_ms,
      d.derived_metrics.lag_p99_ms,
      d.derived_metrics.pending_backlog,
    ),
  );
}

function hourlyBucket(iso: string): string {
  const d = new Date(iso);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}
