import type { Env, IngestPayload, DnaSnapshot } from "./types";
import { hourlyBucket, upsertIfChanged } from "./write";

export async function persist(env: Env, payload: IngestPayload): Promise<void> {
  const { observer_id, collected_at, self_health, node } = payload;
  const db = env.DB;
  const updated_at = collected_at;

  await db.batch([
    upsertIfChanged(db, "observers", {
      key: { observer_id },
      content: {
        last_seen_iso: collected_at,
        last_collection_ms: self_health.last_collection_ms,
        uptime_s: self_health.uptime_s,
        schema_version: payload.schema_version,
        n_errors: self_health.n_errors_this_cycle,
        is_healthy: 1,
        binary_version: self_health.binary_version,
      },
    }),
    ...node.apps.map((app) =>
      upsertIfChanged(db, "apps", {
        key: { observer_id, app_id: app.app_id },
        content: {
          happ_name: app.happ_name,
          role_name: app.role_name,
          clone_of_app_id: app.clone_of_app_id ?? null,
        },
        stamp: { updated_at },
      }),
    ),
    ...node.blocks.map((block) =>
      upsertIfChanged(db, "blocks", {
        key: { observer_id, target_id: block.target_id, start_iso: block.start_iso },
        content: { reason: block.reason, end_iso: block.end_iso },
        stamp: { updated_at },
      }),
    ),
    ...supersededGrants(db, observer_id, node.dnas),
    ...node.dnas.flatMap((d) => dnaStatements(db, observer_id, collected_at, d)),
  ]);
}

/** A grant posted with its hash replaces the observer's row for its tag under '', which /diff would count beside it. */
function supersededGrants(
  db: D1Database,
  observer_id: string,
  dnas: DnaSnapshot[],
): D1PreparedStatement[] {
  const tags = new Set(
    dnas.flatMap((d) => d.cap_grants.filter((g) => g.action_hash_b64).map((g) => g.tag ?? "")),
  );
  if (tags.size === 0) return [];
  return [
    db
      .prepare(
        `DELETE FROM cap_grants_by_action
          WHERE observer_id = ? AND action_hash_b64 = '' AND tag IN (SELECT value FROM json_each(?))`,
      )
      .bind(observer_id, JSON.stringify([...tags])),
  ];
}

function dnaStatements(
  db: D1Database,
  observer_id: string,
  collected_at: string,
  d: DnaSnapshot,
): D1PreparedStatement[] {
  const { dna_b64 } = d;
  const updated_at = collected_at;
  const statements = [
    upsertIfChanged(db, "dnas_seen", {
      key: { observer_id, dna_b64 },
      insertOnly: { first_seen_iso: collected_at },
      content: { dna_tag: d.dna_tag ?? null, last_seen_iso: collected_at },
      stamp: { updated_at },
    }),
  ];

  if (d.dna_definition) {
    statements.push(
      upsertIfChanged(db, "dna_definitions", {
        key: { observer_id, dna_b64 },
        content: {
          zomes_json: JSON.stringify(d.dna_definition.zomes),
          properties_json: d.dna_definition.properties_summary_json,
          network_seed: d.dna_definition.network_seed ?? null,
        },
        stamp: { updated_at },
      }),
    );
  }

  for (const a of d.agents) {
    statements.push(
      upsertIfChanged(db, "agents_discovered", {
        key: { observer_id, dna_b64, agent_b64: a.agent_b64 },
        insertOnly: { first_seen_iso: a.first_seen_iso },
        content: {
          agent_tag: a.agent_tag ?? null,
          action_count: a.action_count,
          warrants_issued: a.warrants_issued,
          warrants_against: a.warrants_against,
        },
        // Close/Open are monotonic. A later snapshot whose DHT read misses the
        // op reports false, and must not clear the flag.
        latched: {
          chain_closed: a.chain_closed ? 1 : 0,
          opening_summary_present: a.opening_summary_present ? 1 : 0,
        },
        stamp: { last_seen_iso: a.last_seen_iso, updated_at },
      }),
      // Last-seen moves every post. It is written apart from the upsert so
      // that `updated_at`, and idx_agents_updated with it, move only when the
      // agent's counts or flags change. One keyed UPDATE per agent: a join
      // against json_each costs D1 a row read per pair of agents.
      db
        .prepare(
          `UPDATE agents_discovered SET last_seen_iso = ?4
            WHERE observer_id = ?1 AND dna_b64 = ?2 AND agent_b64 = ?3
              AND last_seen_iso IS NOT ?4`,
        )
        .bind(observer_id, dna_b64, a.agent_b64, a.last_seen_iso),
    );
  }

  for (const w of d.warrants) {
    statements.push(
      upsertIfChanged(db, "warrants", {
        key: { observer_id, op_hash_b64: w.op_hash_b64 },
        insertOnly: {
          dna_b64,
          author_b64: w.author_b64,
          target_b64: w.target_b64,
          ts_iso: w.ts_iso,
          first_seen_at: collected_at,
        },
        content: {
          warrant_type: w.warrant_type,
          authored_ts_iso: w.authored_ts_iso ?? null,
          integrated_ts_iso: w.integrated_ts_iso ?? null,
          validation_status: w.validation_status ?? null,
          signature_b64: w.signature_b64 ?? null,
          proof_summary_json: w.proof_summary ? JSON.stringify(w.proof_summary) : null,
        },
        stamp: { updated_at },
      }),
    );
  }

  for (const cs of d.chain_summaries) {
    statements.push(
      upsertIfChanged(db, "chain_summaries", {
        key: { observer_id, dna_b64, agent_b64: cs.agent_b64 },
        insertOnly: { first_ts_iso: cs.first_ts_iso },
        content: { action_count: cs.action_count },
        stamp: { last_ts_iso: cs.last_ts_iso, updated_at },
      }),
    );
  }

  for (const s of d.slice_hashes) {
    statements.push(
      upsertIfChanged(db, "slice_hashes", {
        key: {
          observer_id,
          dna_b64,
          arc_start: s.arc_start,
          arc_end: s.arc_end,
          slice_index: s.slice_index,
        },
        content: { hash_b64: s.hash_b64 },
        stamp: { updated_at },
      }),
    );
  }

  for (const l of d.chain_locks) {
    statements.push(
      upsertIfChanged(db, "chain_locks", {
        key: { observer_id, dna_b64, author_b64: l.author_b64, subject_b64: l.subject_b64 },
        content: { expires_at_iso: l.expires_at_iso },
        stamp: { updated_at },
      }),
    );
  }

  for (const f of d.scheduled_functions) {
    statements.push(
      upsertIfChanged(db, "scheduled_functions", {
        key: { observer_id, dna_b64, author_b64: f.author_b64, zome: f.zome, fn_name: f.fn_name },
        content: { scheduled_at_iso: f.scheduled_at_iso },
        stamp: { updated_at },
      }),
    );
  }

  for (const c of d.validation_coverage) {
    statements.push(
      upsertIfChanged(db, "validation_coverage", {
        key: { observer_id, dna_b64, op_hash_b64: c.op_hash_b64 },
        content: { receipt_count: c.receipt_count },
        stamp: { updated_at },
      }),
    );
  }

  for (const g of d.cap_grants) {
    statements.push(
      upsertIfChanged(db, "cap_grants_by_action", {
        key: { observer_id, action_hash_b64: g.action_hash_b64 ?? "", tag: g.tag ?? "" },
        content: {
          app_id: g.app_id,
          cell_b64: g.cell_b64,
          function_count: g.function_count,
          access_type: g.access_type,
        },
        stamp: { updated_at },
      }),
    );
  }

  statements.push(
    upsertIfChanged(db, "derived_metrics_ts", {
      key: { observer_id, dna_b64, bucket_hour_iso: hourlyBucket(collected_at) },
      content: {
        integration_rate: d.derived_metrics.integration_rate ?? null,
        lag_p50_ms: d.derived_metrics.lag_p50_ms ?? null,
        lag_p99_ms: d.derived_metrics.lag_p99_ms ?? null,
        pending_backlog: d.derived_metrics.pending_backlog ?? null,
      },
    }),
  );

  return statements;
}
