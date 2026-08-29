DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM message_jobs
    WHERE openwa_message_id IS NOT NULL
    GROUP BY session_id, openwa_message_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce session-scoped OpenWA message identity: duplicate (session_id, openwa_message_id) rows exist';
  END IF;
END $$;

DROP INDEX IF EXISTS idx_message_jobs_openwa_message_id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_message_jobs_session_openwa_message_id
  ON message_jobs (session_id, openwa_message_id)
  WHERE openwa_message_id IS NOT NULL;

ALTER TABLE message_events
  ADD COLUMN IF NOT EXISTS projection_state text NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS projection_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS projected_job_id uuid REFERENCES message_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS projected_at timestamptz;

DO $$ BEGIN
  ALTER TABLE message_events
    ADD CONSTRAINT message_events_projection_state_check
    CHECK (projection_state IN ('PENDING', 'APPLIED', 'IGNORED'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_message_events_pending_projection
  ON message_events (occurred_at, event_id)
  WHERE projection_state = 'PENDING';
