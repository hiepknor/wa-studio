CREATE TABLE IF NOT EXISTS openwa_safety_outcome_receipts (
  permit_token uuid PRIMARY KEY,
  upstream_id text NOT NULL,
  session_id text NOT NULL DEFAULT '',
  operation_class text NOT NULL,
  outcome_kind text NOT NULL,
  policy_version integer NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (upstream_id ~ '^[0-9a-f]{64}$'),
  CHECK (char_length(session_id) <= 200),
  CHECK (operation_class IN (
    'RECOVERY_PROBE', 'GROUP_READ_TARGETED', 'MESSAGE_SEND_TEXT', 'MESSAGE_SEND_IMAGE',
    'SESSION_READ', 'GROUP_READ_BULK', 'WEBHOOK_CONTROL', 'CONTACT_READ', 'PAGINATED_READ_PAGE'
  )),
  CHECK (outcome_kind IN (
    'SUCCESS', 'SAFE_REJECTION', 'RATE_LIMITED', 'TRANSIENT_FAILURE', 'AMBIGUOUS',
    'SESSION_RESTRICTED'
  )),
  CHECK (policy_version > 0)
);

CREATE INDEX IF NOT EXISTS idx_openwa_safety_outcome_receipts_recorded
  ON openwa_safety_outcome_receipts (recorded_at, permit_token);
