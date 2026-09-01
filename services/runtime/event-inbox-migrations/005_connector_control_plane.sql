CREATE TABLE event_inbox_connectors (
  connector_id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES event_inbox_devices(device_id),
  token_generation bigint NOT NULL DEFAULT 1 CHECK (token_generation > 0),
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_authenticated_at timestamptz
);
CREATE INDEX idx_event_inbox_connectors_device
  ON event_inbox_connectors (device_id, connector_id)
  WHERE revoked_at IS NULL;

CREATE TABLE event_inbox_connector_sessions (
  connector_id uuid NOT NULL REFERENCES event_inbox_connectors(connector_id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_id, session_id)
);
CREATE INDEX idx_event_inbox_connector_sessions_session
  ON event_inbox_connector_sessions (session_id, connector_id);

CREATE TABLE event_inbox_connector_bindings (
  session_id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES event_inbox_devices(device_id),
  webhook_id text NOT NULL CHECK (length(webhook_id) BETWEEN 1 AND 512),
  binding_generation bigint NOT NULL CHECK (binding_generation > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE event_inbox_connector_heartbeats (
  connector_id uuid NOT NULL,
  session_id uuid NOT NULL,
  plugin_version text NOT NULL CHECK (length(plugin_version) BETWEEN 1 AND 128),
  protocol_version integer NOT NULL CHECK (protocol_version > 0),
  journal_schema_version integer NOT NULL CHECK (journal_schema_version > 0),
  reported_binding_generation bigint NOT NULL CHECK (reported_binding_generation >= 0),
  pending_count bigint NOT NULL CHECK (pending_count >= 0),
  oldest_pending_seconds bigint CHECK (oldest_pending_seconds IS NULL OR oldest_pending_seconds >= 0),
  storage_utilization double precision NOT NULL
    CHECK (storage_utilization >= 0 AND storage_utilization <= 1),
  blocked_reason text CHECK (blocked_reason IS NULL OR length(blocked_reason) BETWEEN 1 AND 256),
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_id, session_id),
  FOREIGN KEY (connector_id, session_id)
    REFERENCES event_inbox_connector_sessions(connector_id, session_id) ON DELETE CASCADE
);
CREATE INDEX idx_event_inbox_connector_heartbeats_observed
  ON event_inbox_connector_heartbeats (observed_at, connector_id, session_id);
