-- 0004_migration_counters: surface per-agent migration status so each DNA's
-- view can show two counters (agents closed / agents opened). The observer now
-- derives these booleans from the chain-terminating system actions already in
-- the DHT (CloseChain / OpenChain) — no new scan. Defaulting to 0 keeps every
-- existing row valid until the next observer cycle re-upserts it; the columns
-- ride the existing (observer, dna, agent) row, so the table stays bounded by
-- fleet size and the counters cannot grow with window duration.

ALTER TABLE agents_discovered ADD COLUMN chain_closed            INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents_discovered ADD COLUMN opening_summary_present INTEGER NOT NULL DEFAULT 0;
