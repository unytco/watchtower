-- Run by scripts/wipe-dna.sh with __DNA__ replaced by a validated 52-char base64url DNA hash.
--
-- One statement per line: the script derives its per-table row-count preview from each line.
-- alert_incidents and warrant_sightings look up the DNA's op hashes in warrants, so they run before it.
-- Alert entity keys name a DNA as `<observer>:<dna>:…` or through a warrant's op hash (worker/src/alerts.ts).
-- instr, not LIKE: LIKE ignores case and reads `_` as a wildcard, and base64url has both.
-- Left alone on purpose:
--   cap_grants: its cell_b64 is always empty.
--   analysis_runs: each row is a cron snapshot across every DNA, holding op hashes only.
--   blocks: node-scoped; a cell block names the DNA inside target_id, but the conductor never
--   drops its block spans, so observers re-post them whether or not the DNA still runs.
DELETE FROM alert_incidents WHERE instr(entity_key, ':__DNA__:') > 0 OR entity_key IN (SELECT op_hash_b64 FROM warrants WHERE dna_b64 = '__DNA__');
DELETE FROM warrant_sightings WHERE op_hash_b64 IN (SELECT op_hash_b64 FROM warrants WHERE dna_b64 = '__DNA__');
DELETE FROM warrants WHERE dna_b64 = '__DNA__';
DELETE FROM agents_discovered WHERE dna_b64 = '__DNA__';
DELETE FROM chain_summaries WHERE dna_b64 = '__DNA__';
DELETE FROM slice_hashes WHERE dna_b64 = '__DNA__';
DELETE FROM chain_locks WHERE dna_b64 = '__DNA__';
DELETE FROM scheduled_functions WHERE dna_b64 = '__DNA__';
DELETE FROM validation_coverage WHERE dna_b64 = '__DNA__';
DELETE FROM derived_metrics_ts WHERE dna_b64 = '__DNA__';
DELETE FROM bridge_services WHERE dna_b64 = '__DNA__';
DELETE FROM bridge_backlog WHERE dna_b64 = '__DNA__';
DELETE FROM bridge_throughput_ts WHERE dna_b64 = '__DNA__';
DELETE FROM dna_definitions WHERE dna_b64 = '__DNA__';
DELETE FROM dna_tags WHERE dna_b64 = '__DNA__';
DELETE FROM dnas_seen WHERE dna_b64 = '__DNA__';
