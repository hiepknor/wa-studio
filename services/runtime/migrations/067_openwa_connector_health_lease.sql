CREATE TYPE openwa_connector_health_state AS ENUM (
  'NOT_CONFIGURED',
  'AWAITING_PLUGIN',
  'RECOVERING',
  'HEALTHY',
  'STALE',
  'BLOCKED',
  'BINDING_MISMATCH',
  'UNAVAILABLE'
);

CREATE TABLE openwa_connector_sessions (
  session_id text PRIMARY KEY,
  desired_webhook_id text,
  binding_generation bigint NOT NULL DEFAULT 0 CHECK (binding_generation >= 0),
  binding_synced_at timestamptz,
  connector_id uuid,
  plugin_version text,
  protocol_version integer,
  journal_schema_version integer,
  reported_binding_generation bigint CHECK (reported_binding_generation >= 0),
  pending_count bigint CHECK (pending_count >= 0),
  oldest_pending_seconds bigint CHECK (oldest_pending_seconds >= 0),
  storage_utilization double precision CHECK (
    storage_utilization >= 0 AND storage_utilization <= 1
  ),
  blocked_reason text,
  heartbeat_observed_at timestamptz,
  last_polled_at timestamptz,
  last_poll_error text,
  consecutive_healthy_heartbeats integer NOT NULL DEFAULT 0 CHECK (
    consecutive_healthy_heartbeats >= 0
  ),
  health_state openwa_connector_health_state NOT NULL DEFAULT 'NOT_CONFIGURED',
  health_reason text,
  health_lease_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (desired_webhook_id IS NULL AND binding_generation = 0)
    OR (desired_webhook_id IS NOT NULL AND binding_generation > 0)
  )
);

CREATE INDEX openwa_connector_sessions_health_lease_idx
  ON openwa_connector_sessions (health_lease_expires_at)
  WHERE health_state = 'HEALTHY';
