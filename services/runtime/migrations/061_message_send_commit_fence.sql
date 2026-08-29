ALTER TABLE message_jobs
  ADD COLUMN IF NOT EXISTS claim_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS current_upstream_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS safety_lease_token uuid,
  ADD COLUMN IF NOT EXISTS safety_policy_version integer,
  ADD COLUMN IF NOT EXISTS cancellation_requested_at timestamptz;

UPDATE message_jobs SET claim_count = attempt_count
WHERE claim_count = 0 AND attempt_count > 0;

ALTER TABLE message_jobs
  DROP CONSTRAINT IF EXISTS message_jobs_claim_count_check,
  DROP CONSTRAINT IF EXISTS message_jobs_safety_policy_version_check;

ALTER TABLE message_jobs
  ADD CONSTRAINT message_jobs_claim_count_check CHECK (claim_count >= 0),
  ADD CONSTRAINT message_jobs_safety_policy_version_check
    CHECK (safety_policy_version IS NULL OR safety_policy_version > 0);

ALTER TABLE message_attempts
  ADD COLUMN IF NOT EXISTS upstream_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS safety_policy_version integer;

ALTER TABLE message_attempts
  DROP CONSTRAINT IF EXISTS message_attempts_safety_policy_version_check;

ALTER TABLE message_attempts
  ADD CONSTRAINT message_attempts_safety_policy_version_check
    CHECK (safety_policy_version IS NULL OR safety_policy_version > 0);

CREATE INDEX IF NOT EXISTS idx_message_jobs_session_due
  ON message_jobs (session_id, scheduled_at, created_at, id)
  WHERE status = 'SCHEDULED';

CREATE INDEX IF NOT EXISTS idx_message_jobs_current_send
  ON message_jobs (session_id, current_upstream_started_at)
  WHERE status = 'PROCESSING' AND current_upstream_started_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_jobs_recipient_frequency
  ON message_jobs (session_id, recipient_id, current_upstream_started_at DESC)
  WHERE current_upstream_started_at IS NOT NULL;
