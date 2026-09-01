CREATE TABLE event_inbox_connector_binding_history (
  session_id uuid NOT NULL,
  device_id uuid NOT NULL REFERENCES event_inbox_devices(device_id),
  webhook_id text NOT NULL CHECK (length(webhook_id) BETWEEN 1 AND 512),
  binding_generation bigint NOT NULL CHECK (binding_generation > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, binding_generation),
  UNIQUE (session_id, binding_generation, webhook_id)
);

INSERT INTO event_inbox_connector_binding_history
  (session_id, device_id, webhook_id, binding_generation, created_at)
SELECT session_id, device_id, webhook_id, binding_generation, updated_at
FROM event_inbox_connector_bindings
ON CONFLICT (session_id, binding_generation) DO NOTHING;

CREATE INDEX idx_event_inbox_connector_binding_history_device
  ON event_inbox_connector_binding_history
    (device_id, session_id, binding_generation DESC);
