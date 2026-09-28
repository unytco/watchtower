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
