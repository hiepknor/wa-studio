ALTER TABLE event_inbox_connectors
  DROP CONSTRAINT event_inbox_connectors_device_id_fkey,
  ADD CONSTRAINT event_inbox_connectors_device_id_fkey
    FOREIGN KEY (device_id) REFERENCES event_inbox_devices(device_id) ON DELETE CASCADE;

ALTER TABLE event_inbox_connector_bindings
  DROP CONSTRAINT event_inbox_connector_bindings_device_id_fkey,
  ADD CONSTRAINT event_inbox_connector_bindings_device_id_fkey
    FOREIGN KEY (device_id) REFERENCES event_inbox_devices(device_id) ON DELETE CASCADE,
  DROP CONSTRAINT event_inbox_connector_bindings_connector_id_fkey,
  ADD CONSTRAINT event_inbox_connector_bindings_connector_id_fkey
    FOREIGN KEY (connector_id) REFERENCES event_inbox_connectors(connector_id) ON DELETE CASCADE;

ALTER TABLE event_inbox_connector_binding_history
  DROP CONSTRAINT event_inbox_connector_binding_history_device_id_fkey,
  ADD CONSTRAINT event_inbox_connector_binding_history_device_id_fkey
    FOREIGN KEY (device_id) REFERENCES event_inbox_devices(device_id) ON DELETE CASCADE,
  DROP CONSTRAINT event_inbox_connector_binding_history_connector_id_fkey,
  ADD CONSTRAINT event_inbox_connector_binding_history_connector_id_fkey
    FOREIGN KEY (connector_id) REFERENCES event_inbox_connectors(connector_id) ON DELETE CASCADE;

CREATE FUNCTION event_inbox_guard_retained_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.idempotency_key, 0));
  IF EXISTS (
    SELECT 1 FROM event_inbox_receipts
    WHERE idempotency_key = NEW.idempotency_key AND expires_at > now()
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_event_inbox_guard_retained_receipt
BEFORE INSERT ON event_inbox_events
FOR EACH ROW EXECUTE FUNCTION event_inbox_guard_retained_receipt();
