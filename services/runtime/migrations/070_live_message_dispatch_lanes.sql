ALTER TABLE message_jobs
  ADD COLUMN IF NOT EXISTS defer_reason text;

ALTER TABLE message_jobs
  DROP CONSTRAINT IF EXISTS message_jobs_defer_reason_length_check;

ALTER TABLE message_jobs
  ADD CONSTRAINT message_jobs_defer_reason_length_check
    CHECK (defer_reason IS NULL OR char_length(defer_reason) BETWEEN 1 AND 200);

CREATE TABLE IF NOT EXISTS message_dispatch_session_lanes (
  session_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO message_dispatch_session_lanes (session_id)
SELECT DISTINCT session_id FROM message_jobs
ON CONFLICT (session_id) DO NOTHING;

-- A queued job has not crossed the upstream boundary. Runtime migrations run before
-- queue consumers start, so returning these rows to the durable schedule is safe and
-- prevents legacy multi-claim state from violating the new per-session invariant.
UPDATE message_jobs
SET status = 'SCHEDULED', scheduled_at = LEAST(scheduled_at, now()),
  last_error = 'Recovered while enabling the live session dispatch lane',
  defer_reason = NULL, lease_expires_at = NULL, safety_lease_token = NULL,
  updated_at = now()
WHERE dry_run = false AND status = 'QUEUED';

-- PROCESSING without an upstream start is also safe to replay. A processing job that
-- crossed the upstream boundary remains untouched and continues to fence its session.
UPDATE message_jobs
SET status = 'SCHEDULED', scheduled_at = LEAST(scheduled_at, now()),
  last_error = 'Recovered before upstream start while enabling the live session dispatch lane',
  defer_reason = NULL, lease_expires_at = NULL, safety_lease_token = NULL,
  updated_at = now()
WHERE dry_run = false AND status = 'PROCESSING'
  AND current_upstream_started_at IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM message_jobs
    WHERE dry_run = false AND status IN ('QUEUED', 'PROCESSING')
    GROUP BY session_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot enable live session dispatch lanes while a session has multiple upstream-started jobs';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_message_jobs_live_session_inflight
  ON message_jobs (session_id)
  WHERE dry_run = false AND status IN ('QUEUED', 'PROCESSING');

CREATE INDEX IF NOT EXISTS idx_message_jobs_session_lease_wait
  ON message_jobs (session_id, scheduled_at, created_at, id)
  WHERE dry_run = false AND status = 'SCHEDULED'
    AND defer_reason = 'SESSION_OPERATION_IN_FLIGHT';
