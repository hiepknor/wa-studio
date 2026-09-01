CREATE TABLE IF NOT EXISTS activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  event_type text NOT NULL,
  event_version integer NOT NULL DEFAULT 1,
  category text NOT NULL,
  severity text NOT NULL,
  origin text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  subject_label_snapshot text NOT NULL,
  campaign_id uuid,
  run_id uuid,
  sync_run_id uuid,
  group_id text,
  correlation_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text UNIQUE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (event_version > 0),
  CHECK (category IN ('RUN', 'CAMPAIGN', 'SYNC', 'SESSION')),
  CHECK (severity IN ('INFO', 'SUCCESS', 'WARNING', 'ERROR')),
  CHECK (origin IN ('STUDIO', 'RUNTIME', 'GATEWAY')),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_activity_events_session_occurred
  ON activity_events (session_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_activity_events_session_category_occurred
  ON activity_events (session_id, category, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_activity_events_run
  ON activity_events (run_id, occurred_at DESC)
  WHERE run_id IS NOT NULL;
