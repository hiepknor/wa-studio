CREATE TABLE event_inbox_devices (
  device_id uuid PRIMARY KEY,
  token_version smallint NOT NULL CHECK (token_version IN (1, 2)),
  token_generation bigint NOT NULL CHECK (token_generation >= 0),
  paired_at timestamptz NOT NULL DEFAULT now(),
  token_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_authenticated_at timestamptz,
  CONSTRAINT event_inbox_devices_token_shape CHECK (
    (token_version = 1 AND token_generation = 0)
    OR (token_version = 2 AND token_generation > 0)
  )
);

CREATE TABLE event_inbox_session_owners (
  session_id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES event_inbox_devices(device_id),
  token_generation bigint NOT NULL CHECK (token_generation >= 0),
  acquired_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_event_inbox_session_owners_device
  ON event_inbox_session_owners (device_id, token_generation, session_id);

ALTER TABLE event_inbox_events ADD COLUMN lease_generation bigint;
UPDATE event_inbox_events
SET lease_id = NULL, lease_owner = NULL, lease_expires_at = NULL
WHERE lease_id IS NOT NULL;
ALTER TABLE event_inbox_events DROP CONSTRAINT event_inbox_events_lease_complete;
ALTER TABLE event_inbox_events ADD CONSTRAINT event_inbox_events_lease_complete CHECK (
  (lease_id IS NULL AND lease_owner IS NULL AND lease_generation IS NULL
    AND lease_expires_at IS NULL)
  OR (lease_id IS NOT NULL AND lease_owner IS NOT NULL AND lease_generation IS NOT NULL
    AND lease_expires_at IS NOT NULL)
);
