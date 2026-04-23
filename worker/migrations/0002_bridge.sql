-- Bridge-service reporter tables. Populated by /ingest/bridge, which is
-- called by the bridge-orchestrator ~every minute. Shares the existing
-- `observer_secrets` table for HMAC auth (an orchestrator is registered
-- as an `observer_id` for the purposes of auth only — it does not show
-- up in the `observers` table).
--
-- Data model mirrors the Tier-1 discipline: latest-state upsert + one
-- small hourly timeseries. No per-item bodies.

-- ------------------------------------------------------------------
-- Latest-state service health (one row per reporter)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bridge_services (
  observer_id                 TEXT PRIMARY KEY,
  dna_b64                     TEXT NOT NULL,
  last_seen_iso               TEXT NOT NULL,
  uptime_s                    INTEGER NOT NULL,
  binary_version              TEXT NOT NULL,
  last_cycle_at_iso           TEXT,
  last_cycle_ms               INTEGER,
  consecutive_failed_cycles   INTEGER NOT NULL DEFAULT 0,
  reconnect_failures_total    INTEGER NOT NULL DEFAULT 0,
  reconnects_ok_total         INTEGER NOT NULL DEFAULT 0,
  pressure_active             INTEGER NOT NULL DEFAULT 0,
  pressure_consecutive        INTEGER NOT NULL DEFAULT 0,
  stage_ejections_total       INTEGER NOT NULL DEFAULT 0,
  is_stuck                    INTEGER NOT NULL DEFAULT 0,
  last_error                  TEXT,
  last_error_at_iso           TEXT,
  updated_at                  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bridge_services_dna ON bridge_services (dna_b64);

-- ------------------------------------------------------------------
-- Latest-state backlog snapshot (one row per reporter)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bridge_backlog (
  observer_id                 TEXT PRIMARY KEY,
  dna_b64                     TEXT NOT NULL,
  collected_at                TEXT NOT NULL,
  detected                    INTEGER NOT NULL,
  queued                      INTEGER NOT NULL,
  claimed                     INTEGER NOT NULL,
  in_flight                   INTEGER NOT NULL,
  succeeded_total             INTEGER NOT NULL,
  failed_total                INTEGER NOT NULL,
  oldest_queued_age_s         INTEGER,
  updated_at                  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bridge_backlog_dna ON bridge_backlog (dna_b64);

-- ------------------------------------------------------------------
-- Hourly throughput timeseries (succeeded/failed per hour).
-- Upsert-on-each-report: we accept the latest values for the current
-- bucket, so the orchestrator can keep posting its rolling 1h counts
-- and the dashboard renders a smooth sparkline. Older buckets are
-- frozen once the hour rolls over.
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bridge_throughput_ts (
  observer_id                 TEXT NOT NULL,
  dna_b64                     TEXT NOT NULL,
  bucket_hour_iso             TEXT NOT NULL,
  succeeded                   INTEGER NOT NULL,
  failed                      INTEGER NOT NULL,
  avg_time_to_succeed_s       REAL,
  PRIMARY KEY (observer_id, dna_b64, bucket_hour_iso)
);
CREATE INDEX IF NOT EXISTS idx_bridge_throughput_dna_bucket
  ON bridge_throughput_ts (dna_b64, bucket_hour_iso);
