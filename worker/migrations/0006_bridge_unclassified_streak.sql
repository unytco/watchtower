-- 0006_bridge_unclassified_streak: give the bridge's unclassified-failure class
-- the same alertable surface the source-chain-pressure class already has (B111).
-- The orchestrator cools down on a cycle error matching none of ham's
-- classifiers, but until now escalated only through log events — nothing a
-- watchtower alert could read. The reporter now posts `unclassified_active` /
-- `unclassified_consecutive` alongside the pressure pair, so these mirror
-- `pressure_active` / `pressure_consecutive` exactly.
--
-- Defaulting to 0 keeps every existing row valid: a bridge that predates the
-- reporter change simply omits the fields and persists as "no streak" until it
-- is redeployed. The columns ride the existing one-row-per-reporter table, so
-- the table stays bounded by fleet size.

ALTER TABLE bridge_services ADD COLUMN unclassified_active      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bridge_services ADD COLUMN unclassified_consecutive INTEGER NOT NULL DEFAULT 0;
