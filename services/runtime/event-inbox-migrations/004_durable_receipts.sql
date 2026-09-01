CREATE TABLE event_inbox_receipts (
  idempotency_key text PRIMARY KEY,
  session_id uuid NOT NULL,
  payload_hash bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX idx_event_inbox_receipts_expiry
  ON event_inbox_receipts (expires_at, idempotency_key);
ALTER TABLE event_inbox_receipts SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.05,
  autovacuum_analyze_threshold = 1000
);
