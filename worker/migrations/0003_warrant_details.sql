-- 0003_warrant_details: surface the structured warrant fields the observer
-- now ships in Tier-1 so the dashboard can render the validation status,
-- integration timestamp, and decoded proof without round-tripping a Debug
-- string. New columns are NULL-able so existing rows keep working until the
-- next observer cycle re-upserts them with the full payload.

ALTER TABLE warrants ADD COLUMN authored_ts_iso     TEXT;
ALTER TABLE warrants ADD COLUMN integrated_ts_iso   TEXT;
ALTER TABLE warrants ADD COLUMN validation_status   TEXT;
ALTER TABLE warrants ADD COLUMN signature_b64       TEXT;
ALTER TABLE warrants ADD COLUMN proof_summary_json  TEXT;
