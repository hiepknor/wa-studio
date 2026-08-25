ALTER TABLE campaign_runs
  ADD COLUMN IF NOT EXISTS campaign_name_snapshot text;

UPDATE campaign_runs cr
SET campaign_name_snapshot = c.name
FROM campaigns c
WHERE c.id = cr.campaign_id
  AND cr.campaign_name_snapshot IS NULL;

ALTER TABLE campaign_runs
  ALTER COLUMN campaign_name_snapshot SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_campaign_runs_session_created
  ON campaign_runs (session_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_campaign_deliveries_run_status_created
  ON campaign_deliveries (run_id, status, created_at, id);
