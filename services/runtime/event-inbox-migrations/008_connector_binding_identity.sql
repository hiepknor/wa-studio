ALTER TABLE event_inbox_connector_bindings
  ADD COLUMN connector_id uuid REFERENCES event_inbox_connectors(connector_id);

UPDATE event_inbox_connector_bindings AS binding
SET connector_id = (
  SELECT heartbeat.connector_id
  FROM event_inbox_connector_heartbeats AS heartbeat
  JOIN event_inbox_connectors AS connector
    ON connector.connector_id = heartbeat.connector_id
   AND connector.device_id = binding.device_id
   AND connector.revoked_at IS NULL
  WHERE heartbeat.session_id = binding.session_id
  ORDER BY heartbeat.observed_at DESC, heartbeat.connector_id
  LIMIT 1
);

ALTER TABLE event_inbox_connector_binding_history
  ADD COLUMN connector_id uuid REFERENCES event_inbox_connectors(connector_id);

UPDATE event_inbox_connector_binding_history AS history
SET connector_id = binding.connector_id
FROM event_inbox_connector_bindings AS binding
WHERE binding.session_id = history.session_id
  AND binding.binding_generation = history.binding_generation;

DELETE FROM event_inbox_connector_binding_history
WHERE connector_id IS NULL;

DELETE FROM event_inbox_connector_bindings
WHERE connector_id IS NULL;

CREATE INDEX idx_event_inbox_connector_bindings_connector
  ON event_inbox_connector_bindings (connector_id, session_id)
  WHERE connector_id IS NOT NULL;

CREATE INDEX idx_event_inbox_connector_binding_history_connector
  ON event_inbox_connector_binding_history
    (connector_id, session_id, binding_generation DESC)
  WHERE connector_id IS NOT NULL;
