-- unyt-watchtower D1 schema.
--
-- Design rules:
-- - Latest-state upsert tables keep the DB size bounded; every table has
--   `updated_at` so the diff endpoint can answer "what changed since X?".
-- - A single timeseries table powers sparklines (30-day retention via cron).
-- - `ingest_nonces` and `alert_incidents` grow but are trimmed by cron.
-- - No raw chain bodies, no op blobs, no full warrants proofs.

-- ------------------------------------------------------------------
-- Observers & health
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observers (
  observer_id           TEXT PRIMARY KEY,
  last_seen_iso         TEXT NOT NULL,
  last_collection_ms    INTEGER,
  uptime_s              INTEGER,
  schema_version        INTEGER,
  n_errors              INTEGER,
  is_healthy            INTEGER NOT NULL DEFAULT 1,
  dashboard_url         TEXT,
  binary_version        TEXT
);

-- Metadata-only per-snapshot log. No body is stored; we only need "when did
-- X post?" for the health/downtime detector and to compute diffs cheaply.
CREATE TABLE IF NOT EXISTS snapshots (
  observer_id           TEXT NOT NULL,
  collected_at          TEXT NOT NULL,
  schema_version        INTEGER NOT NULL,
  bytes                 INTEGER NOT NULL,
  PRIMARY KEY (observer_id, collected_at)
);

-- ------------------------------------------------------------------
-- Per-DNA tier-1 rows (upsert)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dnas_seen (
  observer_id           TEXT NOT NULL,
  dna_b64               TEXT NOT NULL,
  dna_tag               TEXT,
  first_seen_iso        TEXT NOT NULL,
  last_seen_iso         TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (observer_id, dna_b64)
);

CREATE TABLE IF NOT EXISTS agents_discovered (
  observer_id           TEXT NOT NULL,
  dna_b64               TEXT NOT NULL,
  agent_b64             TEXT NOT NULL,
  agent_tag             TEXT,
  first_seen_iso        TEXT NOT NULL,
  last_seen_iso         TEXT NOT NULL,
  action_count          INTEGER NOT NULL,
  warrants_issued       INTEGER NOT NULL,
  warrants_against      INTEGER NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (observer_id, dna_b64, agent_b64)
);
CREATE INDEX IF NOT EXISTS idx_agents_updated ON agents_discovered (updated_at);

CREATE TABLE IF NOT EXISTS warrants (
  observer_id           TEXT NOT NULL,
  dna_b64               TEXT NOT NULL,
  op_hash_b64           TEXT NOT NULL,
  warrant_type          TEXT NOT NULL,
  author_b64            TEXT NOT NULL,
  target_b64            TEXT NOT NULL,
  ts_iso                TEXT NOT NULL,
  first_seen_at         TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  -- Tier-1 enrichment fields (added in 0003_warrant_details.sql). Nullable
  -- so older observer payloads still ingest cleanly.
  authored_ts_iso       TEXT,
  integrated_ts_iso     TEXT,
  validation_status     TEXT,
  signature_b64         TEXT,
  proof_summary_json    TEXT,
  PRIMARY KEY (observer_id, op_hash_b64)
);
CREATE INDEX IF NOT EXISTS idx_warrants_author ON warrants (author_b64);
CREATE INDEX IF NOT EXISTS idx_warrants_target ON warrants (target_b64);
CREATE INDEX IF NOT EXISTS idx_warrants_updated ON warrants (updated_at);

-- How many observers have seen the same warrant op.
CREATE TABLE IF NOT EXISTS warrant_sightings (
  op_hash_b64           TEXT NOT NULL,
  observer_id           TEXT NOT NULL,
  last_seen_at          TEXT NOT NULL,
  PRIMARY KEY (op_hash_b64, observer_id)
);

CREATE TABLE IF NOT EXISTS slice_hashes (
  observer_id           TEXT NOT NULL,
  dna_b64               TEXT NOT NULL,
  arc_start             INTEGER NOT NULL,
  arc_end               INTEGER NOT NULL,
  slice_index           INTEGER NOT NULL,
  hash_b64              TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (observer_id, dna_b64, arc_start, arc_end, slice_index)
);

CREATE TABLE IF NOT EXISTS chain_locks (
  observer_id           TEXT NOT NULL,
  dna_b64               TEXT NOT NULL,
  author_b64            TEXT NOT NULL,
  subject_b64           TEXT NOT NULL,
  expires_at_iso        TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (observer_id, dna_b64, author_b64, subject_b64)
);

CREATE TABLE IF NOT EXISTS scheduled_functions (
  observer_id           TEXT NOT NULL,
  dna_b64               TEXT NOT NULL,
  author_b64            TEXT NOT NULL,
  zome                  TEXT NOT NULL,
  fn_name               TEXT NOT NULL,
  scheduled_at_iso      TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (observer_id, dna_b64, author_b64, zome, fn_name)
);

CREATE TABLE IF NOT EXISTS validation_coverage (
  observer_id           TEXT NOT NULL,
  dna_b64               TEXT NOT NULL,
  op_hash_b64           TEXT NOT NULL,
  receipt_count         INTEGER NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (observer_id, dna_b64, op_hash_b64)
);

CREATE TABLE IF NOT EXISTS dna_definitions (
  observer_id           TEXT NOT NULL,
  dna_b64               TEXT NOT NULL,
  zomes_json            TEXT NOT NULL,
  properties_json       TEXT NOT NULL,
  network_seed          TEXT,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (observer_id, dna_b64)
);

CREATE TABLE IF NOT EXISTS cap_grants (
  observer_id           TEXT NOT NULL,
  app_id                TEXT NOT NULL,
  cell_b64              TEXT NOT NULL,
  tag                   TEXT,
  function_count        INTEGER NOT NULL,
  access_type           TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (observer_id, app_id, cell_b64, tag)
);

CREATE TABLE IF NOT EXISTS blocks (
  observer_id           TEXT NOT NULL,
  target_id             TEXT NOT NULL,
  reason                TEXT NOT NULL,
  start_iso             TEXT NOT NULL,
  end_iso               TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (observer_id, target_id, start_iso)
);

CREATE TABLE IF NOT EXISTS apps (
  observer_id           TEXT NOT NULL,
  app_id                TEXT NOT NULL,
  happ_name             TEXT NOT NULL,
  role_name             TEXT NOT NULL,
  clone_of_app_id       TEXT,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (observer_id, app_id)
);

CREATE TABLE IF NOT EXISTS agent_tags (
  observer_id           TEXT NOT NULL,
  pubkey_b64            TEXT NOT NULL,
  name                  TEXT NOT NULL,
  PRIMARY KEY (observer_id, pubkey_b64)
);

CREATE TABLE IF NOT EXISTS dna_tags (
  observer_id           TEXT NOT NULL,
  dna_b64               TEXT NOT NULL,
  name                  TEXT NOT NULL,
  PRIMARY KEY (observer_id, dna_b64)
);

CREATE TABLE IF NOT EXISTS chain_summaries (
  observer_id           TEXT NOT NULL,
  dna_b64               TEXT NOT NULL,
  agent_b64             TEXT NOT NULL,
  action_count          INTEGER NOT NULL,
  first_ts_iso          TEXT NOT NULL,
  last_ts_iso           TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (observer_id, dna_b64, agent_b64)
);

-- ------------------------------------------------------------------
-- Timeseries (hourly, retained ~30 days)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS derived_metrics_ts (
  observer_id           TEXT NOT NULL,
  dna_b64               TEXT NOT NULL,
  bucket_hour_iso       TEXT NOT NULL,
  integration_rate      REAL NOT NULL,
  lag_p50_ms            INTEGER NOT NULL,
  lag_p99_ms            INTEGER NOT NULL,
  pending_backlog       INTEGER NOT NULL,
  PRIMARY KEY (observer_id, dna_b64, bucket_hour_iso)
);
CREATE INDEX IF NOT EXISTS idx_metrics_bucket ON derived_metrics_ts (bucket_hour_iso);

-- ------------------------------------------------------------------
-- Alerts
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_rules (
  id                    TEXT PRIMARY KEY,
  kind                  TEXT NOT NULL,
  params_json           TEXT NOT NULL,
  recipients_json       TEXT NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_incidents (
  id                    TEXT PRIMARY KEY,
  rule_id               TEXT NOT NULL,
  entity_key            TEXT NOT NULL,
  fired_at              TEXT NOT NULL,
  resolved_at           TEXT,
  last_notified_at      TEXT,
  state                 TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_open
  ON alert_incidents (rule_id, entity_key)
  WHERE state = 'open';

-- ------------------------------------------------------------------
-- Cross-observer analysis, written by the 5-min cron
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analysis_runs (
  id                    TEXT PRIMARY KEY,
  kind                  TEXT NOT NULL,
  computed_at           TEXT NOT NULL,
  result_json           TEXT NOT NULL
);

-- ------------------------------------------------------------------
-- Ingest replay-protection state (10-min window)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingest_nonces (
  nonce                 TEXT PRIMARY KEY,
  observer_id           TEXT NOT NULL,
  ts                    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nonces_ts ON ingest_nonces (ts);

-- ------------------------------------------------------------------
-- Per-observer HMAC secrets (hashed) so the Worker can verify without
-- the plaintext landing in logs. Populated via `wrangler secret put` for
-- production and a dev seed for local.
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observer_secrets (
  observer_id           TEXT PRIMARY KEY,
  secret_hex            TEXT NOT NULL,
  created_at            TEXT NOT NULL
);
