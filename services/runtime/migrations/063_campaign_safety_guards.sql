ALTER TABLE campaign_run_targets
  ADD COLUMN IF NOT EXISTS participants_count_snapshot integer;

ALTER TABLE campaign_run_targets
  DROP CONSTRAINT IF EXISTS campaign_run_targets_participants_count_snapshot_check;

ALTER TABLE campaign_run_targets
  ADD CONSTRAINT campaign_run_targets_participants_count_snapshot_check
    CHECK (participants_count_snapshot IS NULL OR participants_count_snapshot >= 0);

UPDATE campaign_run_targets targets
SET participants_count_snapshot = groups.participants_count
FROM gateway_groups groups
WHERE groups.session_id = targets.session_id
  AND groups.id = targets.group_id
  AND targets.participants_count_snapshot IS NULL;

DO $$
DECLARE
  conflicting_sessions text;
BEGIN
  SELECT string_agg(format('%s (%s active runs)', session_id, active_runs), ', ')
  INTO conflicting_sessions
  FROM (
    SELECT session_id, count(*) AS active_runs
    FROM campaign_runs
    WHERE execution_mode = 'LIVE'
      AND status IN ('PREPARING','BLOCKED','SCHEDULED','RUNNING','PAUSED','CANCELLING')
    GROUP BY session_id
    HAVING count(*) > 1
    ORDER BY session_id
    LIMIT 20
  ) conflicts;

  IF conflicting_sessions IS NOT NULL THEN
    RAISE EXCEPTION
      'cannot enforce one active LIVE campaign per session; reconcile existing runs first: %',
      conflicting_sessions
      USING ERRCODE = '23505',
        HINT = 'Pause or cancel all but one active LIVE run for each listed session, then retry the migration.';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_runs_one_active_live_per_session
  ON campaign_runs (session_id)
  WHERE execution_mode = 'LIVE'
    AND status IN ('PREPARING','BLOCKED','SCHEDULED','RUNNING','PAUSED','CANCELLING');

CREATE OR REPLACE FUNCTION enforce_campaign_run_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
    (OLD.status = 'PREPARING' AND NEW.status IN ('BLOCKED','SCHEDULED','RUNNING','FAILED','CANCELLED','CANCELLING'))
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

CREATE OR REPLACE FUNCTION enforce_message_job_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
    (OLD.status = 'SCHEDULED' AND NEW.status IN ('QUEUED','CANCELLED'))
    OR (OLD.status = 'QUEUED' AND NEW.status IN ('SCHEDULED','PROCESSING','CANCELLED'))
    OR (OLD.status = 'PROCESSING'
      AND NEW.status IN ('SCHEDULED','ACCEPTED','FAILED','UNKNOWN','DRY_RUN_COMPLETED','CANCELLED'))
    OR (OLD.status = 'ACCEPTED' AND NEW.status IN ('SENT','DELIVERED','READ','FAILED'))
    OR (OLD.status = 'SENT' AND NEW.status IN ('DELIVERED','READ'))
    OR (OLD.status = 'DELIVERED' AND NEW.status = 'READ')
    OR (OLD.status = 'UNKNOWN' AND NEW.status IN ('SENT','DELIVERED','READ','FAILED'))
  ) THEN
    RAISE EXCEPTION 'invalid message job status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS campaign_runs_status_transition_guard ON campaign_runs;
CREATE TRIGGER campaign_runs_status_transition_guard
BEFORE UPDATE OF status, completed_at ON campaign_runs
FOR EACH ROW EXECUTE FUNCTION enforce_campaign_run_status_transition();

DROP TRIGGER IF EXISTS message_jobs_status_transition_guard ON message_jobs;
CREATE TRIGGER message_jobs_status_transition_guard
BEFORE UPDATE OF status ON message_jobs
FOR EACH ROW EXECUTE FUNCTION enforce_message_job_status_transition();
