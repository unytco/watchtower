-- 0008_cap_grants_by_action: store each capability grant under the hash of the
-- action that wrote it. Observers post app_id and cell_b64 empty, so cap_grants
-- keeps one row per tag and a node's grants sharing a tag overwrite each other.
--
-- A new table, not a rebuilt cap_grants: a Worker older than this migration
-- upserts cap_grants on its old key while a deploy is in flight and after a
-- rollback.

CREATE TABLE IF NOT EXISTS cap_grants_by_action (
  observer_id           TEXT NOT NULL,
  action_hash_b64       TEXT NOT NULL,
  tag                   TEXT NOT NULL,
  app_id                TEXT NOT NULL,
  cell_b64              TEXT NOT NULL,
  function_count        INTEGER NOT NULL,
  access_type           TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (observer_id, action_hash_b64, tag)
) WITHOUT ROWID;

-- Carried under the key the Worker gives a grant posted without a hash, so an
-- observer that predates action_hash_b64 keeps writing the same row. Where rows
-- share that key, SQLite takes the other columns from the row MAX(updated_at) picks.
INSERT OR IGNORE INTO cap_grants_by_action
  (observer_id, action_hash_b64, tag, app_id, cell_b64, function_count, access_type, updated_at)
  SELECT observer_id, '', COALESCE(tag, ''), app_id, cell_b64, function_count, access_type,
         MAX(updated_at)
    FROM cap_grants
   GROUP BY observer_id, COALESCE(tag, '');
