-- migrate: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_inbox_events_received_active
  ON event_inbox_events (received_at)
  WHERE dead_at IS NULL;
