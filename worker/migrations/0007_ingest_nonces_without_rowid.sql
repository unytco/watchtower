-- 0007_ingest_nonces_without_rowid: store replay nonces WITHOUT ROWID and
-- without idx_nonces_ts, so a nonce insert costs D1 one row write, not three.
-- SQLite cannot change a table's rowid storage in place, so the table is
-- rebuilt with its pending nonces, and idx_nonces_ts is dropped with it.

CREATE TABLE ingest_nonces_new (
  nonce                 TEXT PRIMARY KEY,
  observer_id           TEXT NOT NULL,
  ts                    TEXT NOT NULL
) WITHOUT ROWID;

INSERT INTO ingest_nonces_new (nonce, observer_id, ts)
  SELECT nonce, observer_id, ts FROM ingest_nonces;

DROP TABLE ingest_nonces;
ALTER TABLE ingest_nonces_new RENAME TO ingest_nonces;
