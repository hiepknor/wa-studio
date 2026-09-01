-- Pure event coalescing creates one new revision but does not rewrite every older pending operation.
-- Bulk projection is reserved for actual lifecycle changes (claim, retry, completion, or failure).
CREATE OR REPLACE FUNCTION project_gateway_group_reconciliation_operation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  operation_source text;
  operation_status gateway_group_intent_status;
  lifecycle_changed boolean;
BEGIN
  operation_source := CASE
    WHEN 'manual.capability_refresh' = ANY(NEW.reasons) THEN 'MANUAL'
    ELSE 'SYSTEM'
  END;
  operation_status := CASE
    WHEN NEW.completed_revision >= NEW.requested_revision THEN 'COMPLETED'::gateway_group_intent_status
    WHEN NEW.status = 'RUNNING' AND NEW.claimed_revision < NEW.requested_revision
      THEN 'PENDING'::gateway_group_intent_status
    ELSE NEW.status
  END;

  INSERT INTO gateway_group_reconciliation_operations
    (session_id, group_id, request_revision, source, status, attempt_count,
     requested_at, started_at, next_attempt_at, completed_at, error_code, updated_at)
  VALUES (
    NEW.session_id, NEW.group_id, NEW.requested_revision, operation_source, operation_status,
    CASE WHEN operation_status = 'PENDING' THEN 0 ELSE NEW.attempt_count END,
    NEW.last_requested_at,
    CASE WHEN operation_status = 'RUNNING' THEN NEW.started_at ELSE NULL END,
    NEW.next_attempt_at,
    CASE WHEN operation_status IN ('COMPLETED', 'FAILED') THEN NEW.completed_at ELSE NULL END,
    CASE WHEN operation_status = 'FAILED' THEN NEW.last_error_code ELSE NULL END,
    NEW.updated_at
  )
  ON CONFLICT (session_id, group_id, request_revision) DO UPDATE SET
    source = CASE
      WHEN EXCLUDED.source = 'MANUAL' THEN 'MANUAL'
      ELSE gateway_group_reconciliation_operations.source
    END,
    updated_at = EXCLUDED.updated_at;

  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  lifecycle_changed := OLD.status IS DISTINCT FROM NEW.status
    OR OLD.claimed_revision IS DISTINCT FROM NEW.claimed_revision
    OR OLD.completed_revision IS DISTINCT FROM NEW.completed_revision
    OR OLD.attempt_count IS DISTINCT FROM NEW.attempt_count
    OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
    OR OLD.last_error_code IS DISTINCT FROM NEW.last_error_code;

  IF NOT lifecycle_changed THEN
    UPDATE gateway_group_reconciliation_operations operations SET
      source = CASE WHEN operation_source = 'MANUAL' THEN 'MANUAL' ELSE operations.source END,
      next_attempt_at = NEW.next_attempt_at,
      updated_at = NEW.updated_at
    WHERE operations.session_id = NEW.session_id
      AND operations.group_id = NEW.group_id
      AND operations.request_revision = NEW.requested_revision
      AND operations.status NOT IN ('COMPLETED', 'FAILED');
    RETURN NEW;
  END IF;

  UPDATE gateway_group_reconciliation_operations operations SET
    source = CASE
      WHEN operations.request_revision = NEW.requested_revision AND operation_source = 'MANUAL'
        THEN 'MANUAL'
      ELSE operations.source
    END,
    status = CASE
      WHEN operations.request_revision <= NEW.completed_revision
        THEN 'COMPLETED'::gateway_group_intent_status
      WHEN NEW.status = 'RUNNING'
        AND operations.request_revision <= COALESCE(NEW.claimed_revision, 0)
        THEN 'RUNNING'::gateway_group_intent_status
      WHEN NEW.status = 'RUNNING' THEN 'PENDING'::gateway_group_intent_status
      ELSE NEW.status
    END,
    attempt_count = CASE
      WHEN operations.request_revision <= NEW.completed_revision THEN NEW.attempt_count
      WHEN NEW.status = 'PENDING' THEN 0
      WHEN NEW.status = 'RUNNING'
        AND operations.request_revision > COALESCE(NEW.claimed_revision, 0) THEN 0
      ELSE NEW.attempt_count
    END,
    started_at = CASE
      WHEN NEW.status = 'RUNNING'
        AND operations.request_revision <= COALESCE(NEW.claimed_revision, 0)
        THEN COALESCE(operations.started_at, NEW.started_at)
      ELSE operations.started_at
    END,
    next_attempt_at = NEW.next_attempt_at,
    completed_at = CASE
      WHEN operations.request_revision <= NEW.completed_revision
        THEN COALESCE(NEW.completed_at, NEW.updated_at)
      WHEN NEW.status = 'FAILED' THEN COALESCE(NEW.completed_at, NEW.updated_at)
      ELSE NULL
    END,
    error_code = CASE WHEN NEW.status = 'FAILED' THEN NEW.last_error_code ELSE NULL END,
    updated_at = NEW.updated_at
  WHERE operations.session_id = NEW.session_id
    AND operations.group_id = NEW.group_id
    AND operations.request_revision <= NEW.requested_revision
    AND operations.status NOT IN ('COMPLETED', 'FAILED');

  RETURN NEW;
END;
$$;
