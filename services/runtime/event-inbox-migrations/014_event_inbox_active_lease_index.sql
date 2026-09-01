-- migrate: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_inbox_events_lease_active
  ON event_inbox_events (lease_expires_at)
  WHERE dead_at IS NULL AND lease_expires_at IS NOT NULL;
