-- Keep a revision-stable projection for every targeted group reconciliation. The intent row is a
-- mutable scheduler aggregate and cannot safely answer historical operation reads on its own.
CREATE TABLE IF NOT EXISTS gateway_group_reconciliation_operations (
  session_id text NOT NULL,
  group_id text NOT NULL,
  request_revision bigint NOT NULL,
  source text NOT NULL,
  status gateway_group_intent_status NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  requested_at timestamptz NOT NULL,
  started_at timestamptz,
  next_attempt_at timestamptz NOT NULL,
  completed_at timestamptz,
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, group_id, request_revision),
  FOREIGN KEY (session_id, group_id)
    REFERENCES gateway_group_reconciliation_intents(session_id, group_id) ON DELETE CASCADE,
  CHECK (request_revision > 0),
  CHECK (source IN ('MANUAL', 'SYSTEM')),
  CHECK (attempt_count >= 0),
  CHECK (
    (status IN ('COMPLETED', 'FAILED') AND completed_at IS NOT NULL)
    OR (status NOT IN ('COMPLETED', 'FAILED') AND completed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_gateway_group_reconciliation_operations_retention
  ON gateway_group_reconciliation_operations (completed_at)
  WHERE status IN ('COMPLETED', 'FAILED');

-- Preserve all revisions referenced by durable mutation receipts during upgrade.
INSERT INTO gateway_group_reconciliation_operations
  (session_id, group_id, request_revision, source, status, attempt_count,
   requested_at, started_at, next_attempt_at, completed_at, error_code, updated_at)
SELECT intents.session_id, intents.group_id, receipts.result_revision, 'MANUAL',
  CASE
    WHEN intents.completed_revision >= receipts.result_revision THEN 'COMPLETED'::gateway_group_intent_status
    ELSE intents.status
  END,
  intents.attempt_count, receipts.accepted_at, intents.started_at, intents.next_attempt_at,
  CASE
    WHEN intents.completed_revision >= receipts.result_revision
      THEN COALESCE(intents.completed_at, intents.updated_at)
    WHEN intents.status = 'FAILED' THEN COALESCE(intents.completed_at, intents.updated_at)
    ELSE NULL
  END,
  CASE WHEN intents.status = 'FAILED' THEN intents.last_error_code ELSE NULL END,
  intents.updated_at
FROM gateway_group_reconciliation_intents intents
JOIN (
  SELECT DISTINCT ON (session_id, subject_id, result_revision)
    session_id, subject_id, result_revision, accepted_at
  FROM runtime_mutation_receipts
  WHERE operation_type = 'GROUP_CAPABILITY_REFRESH' AND result_revision IS NOT NULL
  ORDER BY session_id, subject_id, result_revision, accepted_at, idempotency_key
) receipts
  ON receipts.session_id = intents.session_id AND receipts.subject_id = intents.group_id
WHERE receipts.result_revision <= intents.requested_revision
ON CONFLICT (session_id, group_id, request_revision) DO NOTHING;

-- Backfill the latest revision for system-created intents and for manual revisions without a receipt.
INSERT INTO gateway_group_reconciliation_operations
  (session_id, group_id, request_revision, source, status, attempt_count,
   requested_at, started_at, next_attempt_at, completed_at, error_code, updated_at)
SELECT session_id, group_id, requested_revision,
  CASE WHEN 'manual.capability_refresh' = ANY(reasons) THEN 'MANUAL' ELSE 'SYSTEM' END,
  status, attempt_count, last_requested_at, started_at, next_attempt_at,
  CASE WHEN status IN ('COMPLETED', 'FAILED')
    THEN COALESCE(completed_at, updated_at) ELSE NULL END,
  CASE WHEN status = 'FAILED' THEN last_error_code ELSE NULL END, updated_at
FROM gateway_group_reconciliation_intents
ON CONFLICT (session_id, group_id, request_revision) DO UPDATE SET
  source = CASE
    WHEN EXCLUDED.source = 'MANUAL' THEN 'MANUAL'
    ELSE gateway_group_reconciliation_operations.source
  END;

CREATE OR REPLACE FUNCTION project_gateway_group_reconciliation_operation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  operation_source text;
  operation_status gateway_group_intent_status;
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

DROP TRIGGER IF EXISTS gateway_group_reconciliation_operation_projection
  ON gateway_group_reconciliation_intents;
CREATE TRIGGER gateway_group_reconciliation_operation_projection
AFTER INSERT OR UPDATE ON gateway_group_reconciliation_intents
FOR EACH ROW EXECUTE FUNCTION project_gateway_group_reconciliation_operation();

-- Normalize rows produced by the pre-guard implementation before validating stronger invariants.
UPDATE sync_runs SET
  phase = 'COMPLETED',
  completed_at = COALESCE(completed_at, updated_at),
  lease_token = NULL,
  lease_expires_at = NULL
WHERE status IN ('COMPLETED', 'FAILED');

UPDATE gateway_sync_items SET
  completed_at = COALESCE(completed_at, updated_at),
  lease_token = NULL,
  lease_expires_at = NULL
WHERE status IN ('COMPLETED', 'FAILED', 'SKIPPED');

UPDATE gateway_group_reconciliation_intents SET
  completed_at = COALESCE(completed_at, updated_at),
  claimed_revision = NULL,
  lease_token = NULL,
  lease_expires_at = NULL
WHERE status IN ('COMPLETED', 'FAILED');

CREATE OR REPLACE FUNCTION enforce_gateway_sync_run_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status AND NOT (
    (OLD.status = 'PENDING' AND NEW.status IN ('RUNNING', 'FAILED'))
    OR (OLD.status = 'RUNNING' AND NEW.status IN ('PENDING', 'COMPLETED', 'FAILED'))
  ) THEN
    RAISE EXCEPTION 'invalid gateway sync run status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  IF NEW.phase NOT IN ('DISCOVERING', 'RECONCILING', 'COMPLETED') THEN
    RAISE EXCEPTION 'invalid gateway sync run phase: %', NEW.phase USING ERRCODE = '23514';
  END IF;
  IF (NEW.lease_token IS NULL) IS DISTINCT FROM (NEW.lease_expires_at IS NULL) THEN
    RAISE EXCEPTION 'gateway sync run lease token and expiry must be paired' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'PENDING' AND (
      NEW.phase <> 'DISCOVERING' OR NEW.sync_epoch IS NOT NULL
      OR NEW.lease_token IS NOT NULL OR NEW.completed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'pending gateway sync run has inconsistent lifecycle fields' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'RUNNING' AND (
      NEW.sync_epoch IS NULL OR NEW.completed_at IS NOT NULL
      OR (NEW.phase = 'DISCOVERING' AND NEW.lease_token IS NULL)
      OR (NEW.phase = 'RECONCILING' AND NEW.lease_token IS NOT NULL)
      OR NEW.phase = 'COMPLETED') THEN
    RAISE EXCEPTION 'running gateway sync run has inconsistent lifecycle fields' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('COMPLETED', 'FAILED') AND (
      NEW.phase <> 'COMPLETED' OR NEW.completed_at IS NULL OR NEW.lease_token IS NOT NULL) THEN
    RAISE EXCEPTION 'terminal gateway sync run has inconsistent lifecycle fields' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS gateway_sync_runs_state_guard ON sync_runs;
CREATE TRIGGER gateway_sync_runs_state_guard
BEFORE INSERT OR UPDATE ON sync_runs
FOR EACH ROW EXECUTE FUNCTION enforce_gateway_sync_run_state();

CREATE OR REPLACE FUNCTION enforce_gateway_sync_item_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status AND NOT (
    (OLD.status IN ('PENDING', 'RETRY') AND NEW.status = 'RUNNING')
    OR (OLD.status = 'RUNNING' AND NEW.status IN ('RETRY', 'COMPLETED', 'FAILED', 'SKIPPED'))
  ) THEN
    RAISE EXCEPTION 'invalid gateway sync item status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  IF (NEW.lease_token IS NULL) IS DISTINCT FROM (NEW.lease_expires_at IS NULL) THEN
    RAISE EXCEPTION 'gateway sync item lease token and expiry must be paired' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'RUNNING' AND (NEW.lease_token IS NULL OR NEW.completed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'running gateway sync item requires a lease and no completion time' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'RUNNING' AND NEW.lease_token IS NOT NULL THEN
    RAISE EXCEPTION 'non-running gateway sync item cannot retain a lease' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('COMPLETED', 'FAILED', 'SKIPPED') AND NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'terminal gateway sync item requires completed_at' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('PENDING', 'RUNNING', 'RETRY') AND NEW.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'non-terminal gateway sync item cannot have completed_at' USING ERRCODE = '23514';
  END IF;
  IF NEW.attempt_count < 0 THEN
    RAISE EXCEPTION 'gateway sync item attempt_count cannot be negative' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS gateway_sync_items_state_guard ON gateway_sync_items;
CREATE TRIGGER gateway_sync_items_state_guard
BEFORE INSERT OR UPDATE ON gateway_sync_items
FOR EACH ROW EXECUTE FUNCTION enforce_gateway_sync_item_state();

CREATE OR REPLACE FUNCTION enforce_gateway_group_intent_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.requested_revision < OLD.requested_revision
        OR NEW.completed_revision < OLD.completed_revision THEN
      RAISE EXCEPTION 'gateway group intent revisions cannot move backwards' USING ERRCODE = '23514';
    END IF;
    IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
      (OLD.status = 'PENDING' AND NEW.status IN ('RUNNING', 'COMPLETED'))
      OR (OLD.status = 'RUNNING' AND NEW.status IN ('PENDING', 'RETRY', 'COMPLETED', 'FAILED'))
      OR (OLD.status = 'RETRY' AND NEW.status IN ('PENDING', 'RUNNING', 'COMPLETED'))
      OR (OLD.status IN ('COMPLETED', 'FAILED') AND NEW.status = 'PENDING'
        AND NEW.requested_revision > OLD.requested_revision)
    ) THEN
      RAISE EXCEPTION 'invalid gateway group intent status transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF (NEW.lease_token IS NULL) IS DISTINCT FROM (NEW.lease_expires_at IS NULL) THEN
    RAISE EXCEPTION 'gateway group intent lease token and expiry must be paired' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'RUNNING' AND (
      NEW.claimed_revision IS NULL OR NEW.lease_token IS NULL OR NEW.completed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'running gateway group intent has inconsistent lifecycle fields' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'RUNNING' AND (
      NEW.claimed_revision IS NOT NULL OR NEW.lease_token IS NOT NULL) THEN
    RAISE EXCEPTION 'non-running gateway group intent cannot retain claim ownership' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'COMPLETED' AND (
      NEW.completed_revision <> NEW.requested_revision OR NEW.completed_at IS NULL) THEN
    RAISE EXCEPTION 'completed gateway group intent must cover its latest revision' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'FAILED' AND NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'failed gateway group intent requires completed_at' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('PENDING', 'RUNNING', 'RETRY') AND NEW.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'non-terminal gateway group intent cannot have completed_at' USING ERRCODE = '23514';
  END IF;
  IF NEW.attempt_count < 0 OR NEW.completed_revision > NEW.requested_revision
      OR NEW.claimed_revision > NEW.requested_revision THEN
    RAISE EXCEPTION 'gateway group intent counters are inconsistent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS gateway_group_intents_state_guard
  ON gateway_group_reconciliation_intents;
CREATE TRIGGER gateway_group_intents_state_guard
BEFORE INSERT OR UPDATE ON gateway_group_reconciliation_intents
FOR EACH ROW EXECUTE FUNCTION enforce_gateway_group_intent_state();
