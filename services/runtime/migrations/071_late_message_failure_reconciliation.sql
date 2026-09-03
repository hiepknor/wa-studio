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
    OR (OLD.status = 'UNKNOWN' AND NEW.status IN ('SENT','DELIVERED','READ','FAILED'))
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

-- Connector ACK_SENT means OpenWA accepted the send command; it is not the final
-- delivery outcome. Repair late ACK_FAILED evidence that the former monotonic
-- reducer ignored, while preserving stronger DELIVERED and READ evidence.
DO $$
DECLARE
  repair record;
  repaired_jobs integer;
  corrected_receipts integer;
  projected_error text;
  safety_outcome text;
BEGIN
  FOR repair IN
    SELECT DISTINCT ON (jobs.id)
      jobs.id AS job_id,
      jobs.session_id,
      attempts.attempt_id,
      attempts.safety_permit_token,
      attempts.safety_upstream_id,
      evidence.event_id,
      evidence.error_class,
      evidence.error_code
    FROM message_delivery_evidence evidence
    JOIN message_attempts attempts ON attempts.attempt_id = evidence.attempt_id
    JOIN message_jobs jobs ON jobs.id = attempts.message_job_id
    WHERE evidence.kind = 'ACK_FAILED'
      AND evidence.projection_state = 'IGNORED'
      AND jobs.status = 'SENT'
      AND attempts.transport_state = 'SENT'
      AND NOT EXISTS (
        SELECT 1 FROM message_delivery_evidence stronger
        WHERE stronger.attempt_id = attempts.attempt_id
          AND stronger.kind IN ('ACK_DELIVERED', 'ACK_READ')
      )
    ORDER BY jobs.id, evidence.sequence DESC
  LOOP
    projected_error := left(concat_ws(': ',
      'Connector ack failed', repair.error_class, repair.error_code), 1024);

    UPDATE message_jobs
    SET status = 'FAILED', last_error = projected_error, updated_at = now()
    WHERE id = repair.job_id AND status = 'SENT';
    GET DIAGNOSTICS repaired_jobs = ROW_COUNT;
    IF repaired_jobs <> 1 THEN
      CONTINUE;
    END IF;

    UPDATE message_attempts
    SET transport_state = 'FAILED_DEFINITIVE', outcome = 'FAILED'
    WHERE attempt_id = repair.attempt_id AND transport_state = 'SENT';

    UPDATE message_delivery_evidence
    SET projection_state = 'APPLIED'
    WHERE event_id = repair.event_id;

    UPDATE campaign_deliveries
    SET status = 'FAILED', failure_reason = projected_error, updated_at = now()
    WHERE message_job_id = repair.job_id AND status = 'SENT';

    IF repair.safety_permit_token IS NULL OR repair.safety_upstream_id IS NULL THEN
      CONTINUE;
    END IF;
    safety_outcome := CASE repair.error_class
      WHEN 'RATE_LIMITED' THEN 'RATE_LIMITED'
      WHEN 'SESSION_RESTRICTED' THEN 'SESSION_RESTRICTED'
      WHEN 'AMBIGUOUS' THEN 'AMBIGUOUS'
      ELSE 'TRANSIENT_FAILURE'
    END;
    UPDATE openwa_safety_outcome_receipts
    SET outcome_kind = safety_outcome, recorded_at = now()
    WHERE permit_token = repair.safety_permit_token AND outcome_kind = 'SUCCESS';
    GET DIAGNOSTICS corrected_receipts = ROW_COUNT;
    IF corrected_receipts <> 1 THEN
      CONTINUE;
    END IF;

    IF safety_outcome = 'RATE_LIMITED' THEN
      UPDATE openwa_safety_scopes SET rate_mode = 'THROTTLED',
        reason_code = CASE WHEN circuit_state = 'MANUAL_BLOCKED'
          THEN reason_code ELSE 'UPSTREAM_RATE_LIMIT' END,
        cooldown_until = CASE WHEN circuit_state = 'MANUAL_BLOCKED' THEN cooldown_until
          ELSE GREATEST(COALESCE(cooldown_until, '-infinity'::timestamptz),
            now() + interval '60 seconds') END,
        circuit_state = CASE WHEN circuit_state = 'HALF_OPEN' THEN 'OPEN' ELSE circuit_state END,
        consecutive_rate_limits = consecutive_rate_limits + 1, success_streak = 0,
        last_failure_at = now(), last_rate_pressure_at = now(), revision = revision + 1,
        updated_at = now()
      WHERE (scope_type = 'UPSTREAM' AND upstream_id = repair.safety_upstream_id AND session_id = '')
         OR (scope_type = 'SESSION' AND upstream_id = repair.safety_upstream_id
           AND session_id = repair.session_id)
         OR (scope_type = 'WORKSPACE' AND upstream_id = '' AND session_id = '');
      UPDATE openwa_safety_buckets SET emission_interval_ms = LEAST(
        effective_rate_period_ms, emission_interval_ms * 2), updated_at = now()
      WHERE upstream_id = repair.safety_upstream_id
        AND (session_id = '' OR session_id = repair.session_id);
    ELSIF safety_outcome IN ('AMBIGUOUS', 'TRANSIENT_FAILURE') THEN
      IF safety_outcome = 'AMBIGUOUS' THEN
        UPDATE openwa_safety_scopes SET
          consecutive_ambiguous_outcomes = consecutive_ambiguous_outcomes + 1,
          success_streak = 0, last_failure_at = now(),
          circuit_state = CASE WHEN circuit_state = 'MANUAL_BLOCKED' THEN circuit_state
            WHEN circuit_state = 'HALF_OPEN' OR consecutive_ambiguous_outcomes + 1 >= 3
              THEN 'OPEN' ELSE circuit_state END,
          cooldown_until = CASE WHEN circuit_state = 'MANUAL_BLOCKED' THEN cooldown_until
            WHEN circuit_state = 'HALF_OPEN' OR consecutive_ambiguous_outcomes + 1 >= 3
              THEN now() + interval '15 minutes' ELSE cooldown_until END,
          reason_code = CASE WHEN circuit_state = 'MANUAL_BLOCKED' THEN reason_code
            WHEN circuit_state = 'HALF_OPEN' OR consecutive_ambiguous_outcomes + 1 >= 3
              THEN 'AMBIGUOUS_OUTCOME' ELSE reason_code END,
          revision = revision + 1, updated_at = now()
        WHERE (scope_type = 'UPSTREAM' AND upstream_id = repair.safety_upstream_id AND session_id = '')
           OR (scope_type = 'SESSION' AND upstream_id = repair.safety_upstream_id
             AND session_id = repair.session_id)
           OR (scope_type = 'WORKSPACE' AND upstream_id = '' AND session_id = '');
      ELSE
        UPDATE openwa_safety_scopes SET
          consecutive_transient_failures = consecutive_transient_failures + 1,
          success_streak = 0, last_failure_at = now(),
          circuit_state = CASE WHEN circuit_state = 'MANUAL_BLOCKED' THEN circuit_state
            WHEN circuit_state = 'HALF_OPEN' OR consecutive_transient_failures + 1 >= 3
              THEN 'OPEN' ELSE circuit_state END,
          cooldown_until = CASE WHEN circuit_state = 'MANUAL_BLOCKED' THEN cooldown_until
            WHEN circuit_state = 'HALF_OPEN' OR consecutive_transient_failures + 1 >= 3
              THEN now() + interval '15 minutes' ELSE cooldown_until END,
          reason_code = CASE WHEN circuit_state = 'MANUAL_BLOCKED' THEN reason_code
            WHEN circuit_state = 'HALF_OPEN' OR consecutive_transient_failures + 1 >= 3
              THEN 'UPSTREAM_FAILURE_STREAK' ELSE reason_code END,
          revision = revision + 1, updated_at = now()
        WHERE (scope_type = 'UPSTREAM' AND upstream_id = repair.safety_upstream_id AND session_id = '')
           OR (scope_type = 'SESSION' AND upstream_id = repair.safety_upstream_id
             AND session_id = repair.session_id)
           OR (scope_type = 'WORKSPACE' AND upstream_id = '' AND session_id = '');
      END IF;
    ELSIF safety_outcome = 'SESSION_RESTRICTED' THEN
      UPDATE openwa_safety_scopes SET circuit_state = 'MANUAL_BLOCKED',
        reason_code = 'SESSION_RESTRICTED', manual_blocked_at = now(), cooldown_until = NULL,
        last_failure_at = now(), revision = revision + 1, updated_at = now()
      WHERE scope_type = 'SESSION' AND upstream_id = repair.safety_upstream_id
        AND session_id = repair.session_id;
    END IF;
  END LOOP;
END $$;
