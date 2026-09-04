ALTER TABLE event_inbox_events
  ADD COLUMN event_sequence bigint GENERATED ALWAYS AS IDENTITY;

ALTER TABLE event_inbox_events
  ADD CONSTRAINT event_inbox_events_sequence_unique UNIQUE (event_sequence);

CREATE INDEX idx_event_inbox_events_recovery
  ON event_inbox_events (session_id, event_sequence)
  WHERE dead_at IS NULL;

COMMENT ON COLUMN event_inbox_events.event_sequence IS
  'Monotonic local sequence used to establish a bounded Runtime recovery watermark.';
