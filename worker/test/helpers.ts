import { env } from "cloudflare:test";
import type {
  BridgeBacklog,
  BridgePayload,
  BridgeSelfHealth,
  BridgeThroughput,
  DnaSnapshot,
  Env,
  IngestPayload,
  NodeSnapshot,
} from "../src/types";

export function observerPayload(
  observer_id: string,
  collected_at: string,
  node: Partial<NodeSnapshot> = {},
): IngestPayload {
  return {
    schema_version: 1,
    observer_id,
    collected_at,
    self_health: {
      uptime_s: 60,
      last_collection_ms: 100,
      n_errors_this_cycle: 0,
      binary_version: "test",
    },
    node: {
      conductor: {
        holochain_version: "0.7.0",
        admin_port: 8888,
        running_apps: 1,
        paused_apps: 0,
        disabled_apps: 0,
        nonce_count: 1,
        nonce_duplicate_count: 0,
      },
      dnas: [],
      apps: [],
      blocks: [],
      ...node,
    },
  };
}

export function dnaSnapshot(dna_b64: string, fields: Partial<DnaSnapshot> = {}): DnaSnapshot {
  return {
    dna_b64,
    dna_tag: null,
    dna_definition: null,
    agents: [],
    warrants: [],
    chain_summaries: [],
    slice_hashes: [],
    chain_locks: [],
    scheduled_functions: [],
    validation_coverage: [],
    cap_grants: [],
    derived_metrics: { integration_rate: 0, lag_p50_ms: 0, lag_p99_ms: 0, pending_backlog: 0 },
    pending_ops_count: 0,
    integrated_ops_count: 0,
    ...fields,
  };
}

export function bridgePayload(
  observer_id: string,
  dna_b64: string,
  collected_at: string,
  parts: {
    self_health?: Partial<BridgeSelfHealth>;
    backlog?: Partial<BridgeBacklog>;
    throughput?: Partial<BridgeThroughput>;
  } = {},
): BridgePayload {
  return {
    schema_version: 1,
    observer_id,
    collected_at,
    dna_b64,
    self_health: {
      uptime_s: 120,
      binary_version: "test",
      last_cycle_at_iso: collected_at,
      last_cycle_ms: 250,
      consecutive_failed_cycles: 0,
      reconnect_failures_total: 0,
      reconnects_ok_total: 0,
      pressure_active: false,
      pressure_consecutive: 0,
      unclassified_active: false,
      unclassified_consecutive: 0,
      stage_ejections_total: 0,
      is_stuck: false,
      last_error: null,
      last_error_at_iso: null,
      ...parts.self_health,
    },
    backlog: {
      detected: 0,
      queued: 0,
      claimed: 0,
      in_flight: 0,
      succeeded_total: 0,
      failed_total: 0,
      oldest_queued_age_s: null,
      ...parts.backlog,
    },
    throughput: {
      succeeded_1h: 0,
      failed_1h: 0,
      succeeded_24h: 0,
      failed_24h: 0,
      avg_time_to_succeed_s_24h: null,
      ...parts.throughput,
    },
  };
}

/**
 * Apply SQL scripts through D1's exec(), which takes one statement per line.
 * Only whole-line `--` comments are stripped.
 */
export async function applySql(...scripts: string[]): Promise<void> {
  for (const sql of scripts) {
    const statements = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(/;\s*\n/)
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter((s) => s.length > 0)
      .map((s) => `${s};`);
    await env.DB.exec(statements.join("\n"));
  }
}

export async function registerObserver(observerId: string, secretHex: string): Promise<void> {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO observer_secrets (observer_id, secret_hex, created_at) VALUES (?, ?, ?)",
  )
    .bind(observerId, secretHex, new Date().toISOString())
    .run();
}

export interface SignedHeaders {
  schema?: string;
  observer?: string;
  ts?: string;
  nonce?: string;
  sig?: string;
}

/** A POST signed the way the observer and the bridge reporter sign theirs. */
export async function signedRequest(
  path: "/ingest" | "/ingest/bridge",
  observerId: string,
  secretHex: string,
  bodyObj: unknown,
  overrides: SignedHeaders = {},
): Promise<Request> {
  const body = new TextEncoder().encode(JSON.stringify(bodyObj));
  const ts = overrides.ts ?? new Date().toISOString();
  const nonce = overrides.nonce ?? crypto.randomUUID();
  const digest = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", body)));
  const key = await crypto.subtle.importKey(
    "raw",
    fromHex(secretHex),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const canonical = [observerId, ts, nonce, digest].join("\n");
  const sig = toHex(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical))),
  );
  return new Request(`http://test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-watchtower-schema": overrides.schema ?? "1",
      "x-watchtower-observer": overrides.observer ?? observerId,
      "x-watchtower-ts": ts,
      "x-watchtower-nonce": nonce,
      "x-watchtower-sig": overrides.sig ?? sig,
    },
    body,
  });
}

/**
 * The test `env` with a D1 binding that sums D1's billed `rows_written` and
 * `rows_read` over statements run with `run()`, `all()` or `batch()`. A
 * statement run with `first()`, `raw()` or `exec()` goes uncounted.
 */
export function meteredEnv(): { env: Env; rowsWritten: () => number; rowsRead: () => number } {
  let written = 0;
  let read = 0;
  const count = <R extends D1Result>(result: R): R => {
    written += result.meta.rows_written;
    read += result.meta.rows_read;
    return result;
  };
  const metered = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const bind = stmt.bind.bind(stmt);
    const run = stmt.run.bind(stmt);
    const all = stmt.all.bind(stmt);
    return Object.assign(stmt, {
      bind: (...values: unknown[]) => metered(bind(...values)),
      run: async () => count(await run()),
      all: async () => count(await all()),
    });
  };
  const DB = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => metered(target.prepare(sql));
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => (await target.batch(stmts)).map(count);
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { env: { ...env, DB }, rowsWritten: () => written, rowsRead: () => read };
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}
