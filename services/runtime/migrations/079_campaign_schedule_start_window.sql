ALTER TABLE campaign_runs
  ADD COLUMN IF NOT EXISTS schedule_start_deadline_at timestamptz;

-- Existing one-time LIVE runs receive the same conservative start window as new runs. The
-- scheduler startup barrier below will still hold an already-due run before normal dispatch.
UPDATE campaign_runs runs
SET schedule_start_deadline_at = runs.scheduled_at + interval '30 seconds'
FROM campaigns campaigns
WHERE runs.campaign_id = campaigns.id
  AND runs.execution_mode = 'LIVE'
  AND campaigns.schedule_type = 'ONCE'
  AND runs.schedule_start_deadline_at IS NULL;

ALTER TABLE campaign_runs
  DROP CONSTRAINT IF EXISTS campaign_runs_schedule_start_deadline_check;

ALTER TABLE campaign_runs
  ADD CONSTRAINT campaign_runs_schedule_start_deadline_check
    CHECK (
      schedule_start_deadline_at IS NULL
      OR schedule_start_deadline_at >= scheduled_at
    );

CREATE INDEX IF NOT EXISTS idx_campaign_runs_schedule_start_window
  ON campaign_runs (scheduled_at, schedule_start_deadline_at, created_at)
  WHERE execution_mode = 'LIVE'
    AND status IN ('PREPARING', 'SCHEDULED')
    AND schedule_start_deadline_at IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_campaign_run_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
    (OLD.status = 'PREPARING' AND NEW.status IN ('BLOCKED','SCHEDULED','RUNNING','PAUSED','FAILED','CANCELLED','CANCELLING'))
    OR (OLD.status = 'BLOCKED' AND NEW.status IN ('SCHEDULED','RUNNING','CANCELLED','CANCELLING'))
    OR (OLD.status = 'SCHEDULED' AND NEW.status IN ('RUNNING','PAUSED','CANCELLED','CANCELLING'))
    OR (OLD.status = 'RUNNING' AND NEW.status IN ('PAUSED','COMPLETED','PARTIAL_FAILED','CANCELLED','CANCELLING'))
    OR (OLD.status = 'PAUSED' AND NEW.status IN ('BLOCKED','SCHEDULED','RUNNING','CANCELLED','CANCELLING'))
    OR (OLD.status = 'CANCELLING' AND NEW.status = 'CANCELLED')
    OR (OLD.status = 'COMPLETED' AND NEW.status = 'PARTIAL_FAILED')
    OR (OLD.status = 'PARTIAL_FAILED' AND NEW.status = 'COMPLETED')
  ) THEN
    RAISE EXCEPTION 'invalid campaign run status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('COMPLETED','PARTIAL_FAILED','CANCELLED','FAILED')
      AND NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'terminal campaign run status % requires completed_at', NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status NOT IN ('COMPLETED','PARTIAL_FAILED','CANCELLED','FAILED')
      AND NEW.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'non-terminal campaign run status % cannot have completed_at', NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
