ALTER TABLE event_inbox_usage
  ADD COLUMN retained_receipts bigint NOT NULL DEFAULT 0
  CHECK (retained_receipts >= 0);

LOCK TABLE event_inbox_receipts IN SHARE ROW EXCLUSIVE MODE;
UPDATE event_inbox_usage
SET retained_receipts = (SELECT count(*) FROM event_inbox_receipts)
WHERE singleton = true;

-- Keep the ledger correct while the previous Event Inbox binary is still serving
-- during a migrate-then-recreate rolling deployment. Every writer therefore
-- participates without requiring application-version coordination.
CREATE FUNCTION increment_event_inbox_receipt_usage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE event_inbox_usage
  SET retained_receipts = retained_receipts + (SELECT count(*) FROM inserted_receipts)
  WHERE singleton = true;
  RETURN NULL;
END;
$$;

CREATE TRIGGER event_inbox_receipts_usage_insert
AFTER INSERT ON event_inbox_receipts
REFERENCING NEW TABLE AS inserted_receipts
FOR EACH STATEMENT
EXECUTE FUNCTION increment_event_inbox_receipt_usage();

CREATE FUNCTION decrement_event_inbox_receipt_usage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE event_inbox_usage
  SET retained_receipts = GREATEST(
    0,
    retained_receipts - (SELECT count(*) FROM deleted_receipts)
  )
  WHERE singleton = true;
  RETURN NULL;
END;
$$;

CREATE TRIGGER event_inbox_receipts_usage_delete
AFTER DELETE ON event_inbox_receipts
REFERENCING OLD TABLE AS deleted_receipts
FOR EACH STATEMENT
EXECUTE FUNCTION decrement_event_inbox_receipt_usage();
