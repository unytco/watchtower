-- Every D1 row of one DNA, run by scripts/wipe-dna.sh with __DNA__ replaced by a
-- validated 52-char base64url DNA hash.
--
-- One statement per line: the script derives its per-table row-count preview from each line.
-- alert_incidents and warrant_sightings reach the DNA through its warrants, so they run first.
-- Alert entity keys are `<observer>:<dna>:…` or a warrant's op hash (worker/src/alerts.ts).
-- instr, not LIKE: LIKE ignores case and reads `_` as a wildcard, and base64url has both.
-- Left alone on purpose: cap_grants (its cell_b64 is always empty) and analysis_runs
-- (rebuilt by the cron every 5 minutes).
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
