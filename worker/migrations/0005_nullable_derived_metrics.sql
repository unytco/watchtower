-- 0005_nullable_derived_metrics: let a degraded observer read store NULL
-- ("unknown") for the four derived metrics instead of a misleading 0, so the
-- dashboard can render "—" distinct from a DNA that genuinely sits at zero
-- (B107). SQLite cannot drop a column's NOT NULL in place, so the table is
-- rebuilt: the four metric columns become nullable while the key columns stay
-- NOT NULL. Existing rows carry over unchanged (their metrics were real values).

CREATE TABLE derived_metrics_ts_new (
  observer_id           TEXT NOT NULL,
  dna_b64               TEXT NOT NULL,
  bucket_hour_iso       TEXT NOT NULL,
  integration_rate      REAL,
  lag_p50_ms            INTEGER,
  lag_p99_ms            INTEGER,
  pending_backlog       INTEGER,
  PRIMARY KEY (observer_id, dna_b64, bucket_hour_iso)
);

INSERT INTO derived_metrics_ts_new
  (observer_id, dna_b64, bucket_hour_iso, integration_rate, lag_p50_ms, lag_p99_ms, pending_backlog)
  SELECT observer_id, dna_b64, bucket_hour_iso, integration_rate, lag_p50_ms, lag_p99_ms, pending_backlog
    FROM derived_metrics_ts;

DROP TABLE derived_metrics_ts;
ALTER TABLE derived_metrics_ts_new RENAME TO derived_metrics_ts;
CREATE INDEX IF NOT EXISTS idx_metrics_bucket ON derived_metrics_ts (bucket_hour_iso);
