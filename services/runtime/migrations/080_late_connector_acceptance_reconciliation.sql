-- A connector may return SEND_ACCEPTED after Runtime's evidence deadline has already quarantined
-- the attempt as UNKNOWN. The evidence is authoritative for this exact command/attempt/digest and
-- must be allowed to resolve the ambiguity without creating or retrying any outbound work.
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
    OR (OLD.status = 'SENT' AND NEW.status IN ('DELIVERED','READ','FAILED'))
    OR (OLD.status = 'DELIVERED' AND NEW.status = 'READ')
    OR (OLD.status = 'UNKNOWN' AND NEW.status IN ('ACCEPTED','SENT','DELIVERED','READ','FAILED'))
  ) THEN
    RAISE EXCEPTION 'invalid message job status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

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
    OR (OLD.status = 'SENT' AND NEW.status IN ('DELIVERED','READ','FAILED'))
    OR (OLD.status = 'DELIVERED' AND NEW.status = 'READ')
    OR (OLD.status = 'UNKNOWN' AND NEW.status IN ('ACCEPTED','SENT','DELIVERED','READ','FAILED'))
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

-- Retry only connector evidence that exhausted the webhook worker because the former transition
-- graph rejected this one now-supported edge. Other DEAD events remain quarantined for review.
UPDATE webhook_events
SET processing_state = 'RETRY',
    attempt_count = 0,
    next_attempt_at = now(),
    lease_token = NULL,
    lease_expires_at = NULL,
    dead_at = NULL,
    processing_error = 'Requeued after late connector acceptance transition repair'
WHERE processing_state = 'DEAD'
  AND event_type = 'wa-studio.connector.evidence'
  AND payload #>> '{data,kind}' = 'SEND_ACCEPTED'
  AND processing_error LIKE 'invalid message job status transition: UNKNOWN -> ACCEPTED%';

-- Successful resolution must not retain an obsolete failure explanation in the delivery read model.
UPDATE campaign_deliveries
SET failure_reason = NULL, updated_at = now()
WHERE status IN ('PROCESSING','DRY_RUN_COMPLETED','ACCEPTED','SENT','DELIVERED','READ')
  AND failure_reason IS NOT NULL;
