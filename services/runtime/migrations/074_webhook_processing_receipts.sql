ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS payload_sha256 text;

ALTER TABLE webhook_events
  DROP CONSTRAINT IF EXISTS webhook_events_payload_sha256_check;

ALTER TABLE webhook_events
  ADD CONSTRAINT webhook_events_payload_sha256_check
  CHECK (payload_sha256 IS NULL OR payload_sha256 ~ '^[0-9a-f]{64}$') NOT VALID;

CREATE TABLE IF NOT EXISTS webhook_event_receipts (
  idempotency_key text PRIMARY KEY,
  delivery_id text,
  event_type text NOT NULL,
  session_id text,
  payload_sha256 text,
  received_at timestamptz NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  processing_error text,
  expires_at timestamptz NOT NULL,
  CONSTRAINT webhook_event_receipts_payload_sha256_check
    CHECK (payload_sha256 IS NULL OR payload_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_webhook_event_receipts_expiry
  ON webhook_event_receipts (expires_at, idempotency_key);

ALTER TABLE webhook_event_receipts SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 5000,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_analyze_threshold = 2500
);
