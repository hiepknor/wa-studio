CREATE TABLE IF NOT EXISTS event_inbox_events (
  idempotency_key text PRIMARY KEY,
  delivery_id text NOT NULL,
  event_type text NOT NULL,
  session_id uuid NOT NULL,
  raw_body bytea NOT NULL,
  signature text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  storage_bytes bigint NOT NULL CHECK (storage_bytes > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_owner uuid,
  lease_expires_at timestamptz,
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  dead_at timestamptz,
  dead_reason text,
  CONSTRAINT event_inbox_events_lease_complete CHECK (
    (lease_id IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_id IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_event_inbox_events_claim
  ON event_inbox_events (available_at, received_at, idempotency_key)
  WHERE dead_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_event_inbox_events_expiry
  ON event_inbox_events (expires_at);
CREATE INDEX IF NOT EXISTS idx_event_inbox_events_dead
  ON event_inbox_events (dead_at)
  WHERE dead_at IS NOT NULL;
ALTER TABLE event_inbox_events SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.05,
  autovacuum_analyze_threshold = 1000
);

CREATE TABLE IF NOT EXISTS event_inbox_usage (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  stored_events bigint NOT NULL CHECK (stored_events >= 0),
  stored_bytes bigint NOT NULL CHECK (stored_bytes >= 0)
);
LOCK TABLE event_inbox_events IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO event_inbox_usage (singleton, stored_events, stored_bytes)
SELECT true, count(*), COALESCE(sum(storage_bytes), 0)
FROM event_inbox_events
ON CONFLICT (singleton) DO UPDATE SET
  stored_events = EXCLUDED.stored_events,
  stored_bytes = EXCLUDED.stored_bytes;
