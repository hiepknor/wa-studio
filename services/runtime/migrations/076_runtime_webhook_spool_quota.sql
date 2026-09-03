ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS storage_bytes bigint NOT NULL DEFAULT 0;

ALTER TABLE webhook_events
  DROP CONSTRAINT IF EXISTS webhook_events_storage_bytes_check;

ALTER TABLE webhook_events
  ADD CONSTRAINT webhook_events_storage_bytes_check
  CHECK (storage_bytes >= 0) NOT VALID;

WITH active AS (
  SELECT id FROM webhook_events WHERE processing_state IN ('PENDING', 'RETRY')
  UNION ALL
  SELECT id FROM webhook_events WHERE processing_state = 'PROCESSING'
  UNION ALL
  SELECT id FROM webhook_events WHERE processing_state = 'DEAD'
)
UPDATE webhook_events event
SET storage_bytes = pg_column_size(event.payload)
FROM active
WHERE event.id = active.id AND event.storage_bytes = 0;

CREATE TABLE IF NOT EXISTS runtime_webhook_spool_usage (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  stored_events bigint NOT NULL DEFAULT 0 CHECK (stored_events >= 0),
  stored_bytes bigint NOT NULL DEFAULT 0 CHECK (stored_bytes >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO runtime_webhook_spool_usage (singleton, stored_events, stored_bytes)
SELECT true, count(*), COALESCE(sum(storage_bytes), 0)
FROM (
  SELECT storage_bytes FROM webhook_events WHERE processing_state IN ('PENDING', 'RETRY')
  UNION ALL
  SELECT storage_bytes FROM webhook_events WHERE processing_state = 'PROCESSING'
  UNION ALL
  SELECT storage_bytes FROM webhook_events WHERE processing_state = 'DEAD'
) AS active
ON CONFLICT (singleton) DO UPDATE SET
  stored_events = EXCLUDED.stored_events,
  stored_bytes = EXCLUDED.stored_bytes,
  updated_at = now();
