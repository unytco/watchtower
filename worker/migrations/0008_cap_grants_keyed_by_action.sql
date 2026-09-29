-- 0008_cap_grants_keyed_by_action: key each capability grant by the hash of the
-- action that wrote it, since tags repeat within a node. The old rows carry no
-- hash to rekey them by, so the table is dropped.
--
-- precondition: Every observer already runs a build that posts action_hash_b64 with each grant: `make <server>-watchtower` in automation/.
-- precondition: Stored grants are dropped. A post that lands between this migration and the Worker deploy can fail, and each observer re-posts all its grants on its next collection cycle.
-- precondition: There is no rollback past this migration: an older Worker fails every post that reports a capability grant.

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
