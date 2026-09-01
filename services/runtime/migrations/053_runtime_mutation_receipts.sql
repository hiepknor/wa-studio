CREATE TABLE IF NOT EXISTS runtime_mutation_receipts (
  operation_type text NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  session_id text NOT NULL,
  subject_id text NOT NULL,
  result_id text NOT NULL,
  result_revision bigint,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operation_type, idempotency_key),
  CHECK (operation_type IN (
    'SESSION_SYNC',
    'GROUP_CAPABILITY_REFRESH',
    'CAMPAIGN_RUN_PAUSE',
    'CAMPAIGN_RUN_RESUME',
    'CAMPAIGN_RUN_CANCEL'
  )),
  CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CHECK (char_length(session_id) BETWEEN 1 AND 200),
  CHECK (char_length(subject_id) BETWEEN 1 AND 500),
  CHECK (char_length(result_id) BETWEEN 1 AND 500),
  CHECK (result_revision IS NULL OR result_revision > 0)
);

CREATE INDEX IF NOT EXISTS idx_runtime_mutation_receipts_result
  ON runtime_mutation_receipts
    (operation_type, session_id, subject_id, result_revision, accepted_at);
