CREATE TABLE event_inbox_rate_limits (
  scope text NOT NULL CHECK (length(scope) BETWEEN 1 AND 64),
  key_hash bytea NOT NULL CHECK (octet_length(key_hash) = 32),
  window_started_at timestamptz NOT NULL,
  attempts bigint NOT NULL CHECK (attempts > 0),
  blocked_attempts bigint NOT NULL DEFAULT 0 CHECK (blocked_attempts >= 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, key_hash)
);
CREATE INDEX idx_event_inbox_rate_limits_expiry
  ON event_inbox_rate_limits (expires_at, scope, key_hash);
