-- 0008_cap_grants_keyed_by_action: key each capability grant by the hash of the
-- action that wrote it, since tags repeat within a node. The old rows carry no
-- hash to rekey them by, so the table is dropped and observers re-post their
-- grants on their next cycle.

DROP TABLE cap_grants;

CREATE TABLE cap_grants (
  observer_id           TEXT NOT NULL,
  action_hash_b64       TEXT NOT NULL,
  tag                   TEXT,
  app_id                TEXT NOT NULL,
  cell_b64              TEXT NOT NULL,
  function_count        INTEGER NOT NULL,
  access_type           TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (observer_id, action_hash_b64)
) WITHOUT ROWID;
