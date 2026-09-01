-- migrate: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_inbox_events_session_received_active
  ON event_inbox_events (session_id, received_at, idempotency_key)
  WHERE dead_at IS NULL;
