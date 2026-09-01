ALTER TABLE openwa_safety_buckets
  DROP CONSTRAINT IF EXISTS openwa_safety_buckets_operation_class_check;

ALTER TABLE openwa_safety_buckets
  ADD CONSTRAINT openwa_safety_buckets_operation_class_check CHECK (operation_class IN (
    'UPSTREAM_ALL', 'MESSAGE_SEND_ALL', 'RECOVERY_PROBE', 'GROUP_READ_TARGETED',
    'MESSAGE_SEND_TEXT', 'MESSAGE_SEND_IMAGE', 'SESSION_READ', 'GROUP_READ_BULK',
    'WEBHOOK_CONTROL', 'CONTACT_READ', 'PAGINATED_READ_PAGE'
  ));

DELETE FROM openwa_safety_buckets
WHERE scope_type = 'SESSION'
  AND operation_class IN ('MESSAGE_SEND_TEXT', 'MESSAGE_SEND_IMAGE')
  AND window_name IN ('MINUTE', 'HOUR', 'DAY');

ALTER TABLE openwa_safety_scopes
  ALTER COLUMN policy_version SET DEFAULT 5;

ALTER TABLE openwa_safety_buckets
  ALTER COLUMN policy_version SET DEFAULT 5;

UPDATE openwa_safety_scopes
SET policy_version = 5, revision = revision + 1, updated_at = now()
WHERE policy_version < 5;

UPDATE openwa_safety_buckets
SET policy_version = 5, updated_at = now()
WHERE policy_version < 5;
