ALTER TABLE event_inbox_connector_heartbeats
  ADD COLUMN IF NOT EXISTS token_generation bigint;

UPDATE event_inbox_connector_heartbeats AS heartbeat
SET token_generation = connector.token_generation
FROM event_inbox_connectors AS connector
WHERE connector.connector_id = heartbeat.connector_id
  AND heartbeat.token_generation IS NULL;

ALTER TABLE event_inbox_connector_heartbeats
  ALTER COLUMN token_generation SET NOT NULL;

ALTER TABLE event_inbox_connector_heartbeats
  DROP CONSTRAINT IF EXISTS event_inbox_connector_heartbeats_token_generation_check;

ALTER TABLE event_inbox_connector_heartbeats
  ADD CONSTRAINT event_inbox_connector_heartbeats_token_generation_check
  CHECK (token_generation > 0);
