-- Run by scripts/wipe-dna.sh with __DNA__ replaced by a validated 52-char base64url DNA hash.
--
-- One statement per line: the script derives its per-table row-count preview from each line.
-- alert_incidents and warrant_sightings read warrants, so they run before it.
-- Alert entity keys name a DNA as `<observer>:<dna>:…` or are a warrant op hash, which several DNAs' warrants can share (worker/src/alerts.ts).
-- instr, not LIKE: LIKE ignores case and reads `_` as a wildcard, and base64url has both.
-- Left alone on purpose:
--   cap_grants and cap_grants_by_action: their cell_b64 is always empty.
--   analysis_runs: each row is a cron snapshot across every DNA, holding op hashes only.
--   blocks: node-scoped; a cell block names the DNA inside target_id, but the conductor keeps a
--   cell's block spans after its app is uninstalled, so observers re-post them either way.
DELETE FROM alert_incidents WHERE instr(entity_key, ':__DNA__:') > 0 OR entity_key IN (SELECT op_hash_b64 FROM warrants WHERE dna_b64 = '__DNA__' EXCEPT SELECT op_hash_b64 FROM warrants WHERE dna_b64 <> '__DNA__');
DELETE FROM warrant_sightings WHERE (op_hash_b64, observer_id) IN (SELECT op_hash_b64, observer_id FROM warrants WHERE dna_b64 = '__DNA__');
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
