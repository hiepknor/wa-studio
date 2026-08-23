SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS runtime_queue_jobs (
  queue_name text NOT NULL,
  job_id text NOT NULL,
  job_name text NOT NULL,
  payload jsonb NOT NULL,
  priority integer,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (queue_name, job_id),
  CONSTRAINT runtime_queue_jobs_queue_name_check CHECK (
    queue_name IN ('message-send', 'webhook-ingress', 'gateway-sync', 'campaign')
  ),
  CONSTRAINT runtime_queue_jobs_priority_check CHECK (priority IS NULL OR priority > 0),
  CONSTRAINT runtime_queue_jobs_lease_check CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_runtime_queue_jobs_dispatch
  ON runtime_queue_jobs (queue_name, available_at, priority, created_at);

CREATE INDEX IF NOT EXISTS idx_runtime_queue_jobs_expired_lease
  ON runtime_queue_jobs (lease_expires_at)
  WHERE lease_owner IS NOT NULL;

CREATE TABLE IF NOT EXISTS runtime_process_heartbeats (
  process_name text PRIMARY KEY,
  heartbeat_at timestamptz NOT NULL,
  CONSTRAINT runtime_process_heartbeats_name_check CHECK (
    process_name IN ('worker', 'scheduler')
  )
);

CREATE TABLE IF NOT EXISTS runtime_scheduler_tick_states (
  name text PRIMARY KEY,
  state jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runtime_scheduler_tick_states_expiry
  ON runtime_scheduler_tick_states (expires_at);
