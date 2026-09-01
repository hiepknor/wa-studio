DO $$ BEGIN
  CREATE TYPE openwa_safety_scope_type AS ENUM ('WORKSPACE', 'UPSTREAM', 'SESSION');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE openwa_safety_circuit_state AS ENUM ('CLOSED', 'OPEN', 'HALF_OPEN', 'MANUAL_BLOCKED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE openwa_safety_rate_mode AS ENUM ('NORMAL', 'THROTTLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS openwa_safety_scopes (
  scope_type openwa_safety_scope_type NOT NULL,
  upstream_id text NOT NULL DEFAULT '',
  session_id text NOT NULL DEFAULT '',
  circuit_state openwa_safety_circuit_state NOT NULL DEFAULT 'CLOSED',
  rate_mode openwa_safety_rate_mode NOT NULL DEFAULT 'NORMAL',
  reason_code text,
  cooldown_until timestamptz,
  consecutive_rate_limits integer NOT NULL DEFAULT 0,
  consecutive_transient_failures integer NOT NULL DEFAULT 0,
  consecutive_ambiguous_outcomes integer NOT NULL DEFAULT 0,
  success_streak integer NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_rate_pressure_at timestamptz,
  manual_blocked_at timestamptz,
  policy_profile text NOT NULL DEFAULT 'CANARY',
  policy_version integer NOT NULL DEFAULT 4,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, upstream_id, session_id),
  CHECK (upstream_id = '' OR upstream_id ~ '^[0-9a-f]{64}$'),
  CHECK (char_length(session_id) <= 200),
  CHECK (
    (scope_type = 'WORKSPACE' AND upstream_id = '' AND session_id = '')
    OR (scope_type = 'UPSTREAM' AND upstream_id <> '' AND session_id = '')
    OR (scope_type = 'SESSION' AND upstream_id <> '' AND session_id <> '')
  ),
  CHECK (reason_code IS NULL OR char_length(reason_code) BETWEEN 1 AND 200),
  CHECK (consecutive_rate_limits >= 0),
  CHECK (consecutive_transient_failures >= 0),
  CHECK (consecutive_ambiguous_outcomes >= 0),
  CHECK (success_streak >= 0),
  CHECK (policy_profile IN ('CANARY', 'STANDARD')),
  CHECK (policy_version > 0),
  CHECK (revision > 0),
  CHECK ((circuit_state = 'MANUAL_BLOCKED') = (manual_blocked_at IS NOT NULL))
);

INSERT INTO openwa_safety_scopes (scope_type, upstream_id, session_id)
VALUES ('WORKSPACE', '', '')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS openwa_safety_buckets (
  scope_type openwa_safety_scope_type NOT NULL,
  upstream_id text NOT NULL DEFAULT '',
  session_id text NOT NULL DEFAULT '',
  operation_class text NOT NULL,
  window_name text NOT NULL,
  theoretical_arrival_at timestamptz NOT NULL DEFAULT now(),
  base_emission_interval_ms integer NOT NULL,
  emission_interval_ms integer NOT NULL,
  burst_capacity integer NOT NULL DEFAULT 1,
  effective_rate_numerator integer NOT NULL,
  effective_rate_period_ms integer NOT NULL,
  policy_version integer NOT NULL DEFAULT 4,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, upstream_id, session_id, operation_class, window_name),
  FOREIGN KEY (scope_type, upstream_id, session_id)
    REFERENCES openwa_safety_scopes(scope_type, upstream_id, session_id) ON DELETE CASCADE,
  CHECK (operation_class IN (
    'UPSTREAM_ALL', 'RECOVERY_PROBE', 'GROUP_READ_TARGETED', 'MESSAGE_SEND_TEXT', 'MESSAGE_SEND_IMAGE',
    'SESSION_READ', 'GROUP_READ_BULK', 'WEBHOOK_CONTROL', 'CONTACT_READ', 'PAGINATED_READ_PAGE'
  )),
  CHECK (window_name IN ('PACING', 'MINUTE', 'HOUR', 'DAY')),
  CHECK (base_emission_interval_ms > 0),
  CHECK (emission_interval_ms > 0),
  CHECK (burst_capacity > 0),
  CHECK (effective_rate_numerator > 0),
  CHECK (effective_rate_period_ms > 0),
  CHECK (policy_version > 0)
);

CREATE INDEX IF NOT EXISTS idx_openwa_safety_buckets_ready
  ON openwa_safety_buckets (theoretical_arrival_at, operation_class);

CREATE TABLE IF NOT EXISTS openwa_safety_leases (
  scope_type openwa_safety_scope_type NOT NULL,
  upstream_id text NOT NULL DEFAULT '',
  session_id text NOT NULL DEFAULT '',
  lane text NOT NULL,
  lease_token uuid NOT NULL,
  holder_type text NOT NULL,
  holder_id text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, upstream_id, session_id, lane),
  FOREIGN KEY (scope_type, upstream_id, session_id)
    REFERENCES openwa_safety_scopes(scope_type, upstream_id, session_id) ON DELETE CASCADE,
  CHECK (lane IN ('ACTIVE_SESSION', 'RECOVERY')),
  CHECK (holder_type IN ('MESSAGE_JOB', 'GATEWAY_SYNC', 'GROUP_REFRESH', 'CONTACT_SYNC', 'WEBHOOK_RECONCILIATION', 'PROBE')),
  CHECK (char_length(holder_id) BETWEEN 1 AND 500)
);

CREATE INDEX IF NOT EXISTS idx_openwa_safety_leases_expiry
  ON openwa_safety_leases (lease_expires_at);
