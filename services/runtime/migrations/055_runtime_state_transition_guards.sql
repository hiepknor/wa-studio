CREATE OR REPLACE FUNCTION enforce_campaign_run_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
    (OLD.status = 'PREPARING' AND NEW.status IN ('BLOCKED','SCHEDULED','RUNNING','FAILED','CANCELLED'))
    OR (OLD.status = 'BLOCKED' AND NEW.status IN ('SCHEDULED','RUNNING','CANCELLED'))
    OR (OLD.status = 'SCHEDULED' AND NEW.status IN ('RUNNING','PAUSED','CANCELLED'))
    OR (OLD.status = 'RUNNING' AND NEW.status IN ('PAUSED','COMPLETED','PARTIAL_FAILED','CANCELLED'))
    OR (OLD.status = 'PAUSED' AND NEW.status IN ('BLOCKED','SCHEDULED','RUNNING','CANCELLED'))
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

DROP TRIGGER IF EXISTS campaign_runs_status_transition_guard ON campaign_runs;
CREATE TRIGGER campaign_runs_status_transition_guard
BEFORE UPDATE OF status, completed_at ON campaign_runs
FOR EACH ROW EXECUTE FUNCTION enforce_campaign_run_status_transition();

CREATE OR REPLACE FUNCTION enforce_message_job_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
    (OLD.status = 'SCHEDULED' AND NEW.status IN ('QUEUED','CANCELLED'))
    OR (OLD.status = 'QUEUED' AND NEW.status IN ('SCHEDULED','PROCESSING','CANCELLED'))
    OR (OLD.status = 'PROCESSING'
      AND NEW.status IN ('SCHEDULED','ACCEPTED','FAILED','UNKNOWN','DRY_RUN_COMPLETED'))
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

DROP TRIGGER IF EXISTS message_jobs_status_transition_guard ON message_jobs;
CREATE TRIGGER message_jobs_status_transition_guard
BEFORE UPDATE OF status ON message_jobs
FOR EACH ROW EXECUTE FUNCTION enforce_message_job_status_transition();

CREATE OR REPLACE FUNCTION enforce_campaign_delivery_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
    (OLD.status = 'PENDING' AND NEW.status IN ('MATERIALIZED','BLOCKED_CAPABILITY_CHANGED','CANCELLED'))
    OR (OLD.status = 'MATERIALIZED'
      AND NEW.status IN ('PROCESSING','DRY_RUN_COMPLETED','ACCEPTED','SENT','DELIVERED','READ',
        'FAILED','UNKNOWN','CANCELLED'))
    OR (OLD.status = 'PROCESSING'
      AND NEW.status IN ('DRY_RUN_COMPLETED','ACCEPTED','SENT','DELIVERED','READ','FAILED','UNKNOWN'))
    OR (OLD.status = 'ACCEPTED' AND NEW.status IN ('SENT','DELIVERED','READ','FAILED'))
    OR (OLD.status = 'SENT' AND NEW.status IN ('DELIVERED','READ'))
    OR (OLD.status = 'DELIVERED' AND NEW.status = 'READ')
    OR (OLD.status = 'UNKNOWN' AND NEW.status IN ('SENT','DELIVERED','READ','FAILED'))
  ) THEN
    RAISE EXCEPTION 'invalid campaign delivery status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('PENDING','BLOCKED_CAPABILITY_CHANGED') AND NEW.message_job_id IS NOT NULL THEN
    RAISE EXCEPTION 'campaign delivery status % cannot reference a message job', NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('MATERIALIZED','PROCESSING','DRY_RUN_COMPLETED','ACCEPTED','SENT','DELIVERED',
      'READ','FAILED','UNKNOWN') AND NEW.message_job_id IS NULL THEN
    RAISE EXCEPTION 'campaign delivery status % requires a message job', NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS campaign_deliveries_status_transition_guard ON campaign_deliveries;
CREATE TRIGGER campaign_deliveries_status_transition_guard
BEFORE UPDATE OF status, message_job_id ON campaign_deliveries
FOR EACH ROW EXECUTE FUNCTION enforce_campaign_delivery_status_transition();
