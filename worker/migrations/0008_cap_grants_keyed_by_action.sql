-- 0008_cap_grants_keyed_by_action: key each capability grant by the hash of the
-- action that wrote it, since tags repeat within a node. The old rows carry no
-- hash to rekey them by, so the table is dropped.
--
-- precondition: Every observer already runs this release: `make <server>-watchtower` in automation/ for each one.
-- precondition: Stored grants are dropped, and a post that lands between this migration and the Worker deploy can fail. Each observer re-posts all its grants on its next collection cycle.
-- precondition: No rollback past this migration: an older Worker cannot store capability grants.

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
