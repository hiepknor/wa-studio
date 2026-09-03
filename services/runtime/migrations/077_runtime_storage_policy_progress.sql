CREATE TABLE IF NOT EXISTS runtime_storage_policy_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  phase text NOT NULL CHECK (phase IN ('DRAINING', 'LOGICALLY_COMPACT')),
  inbound_messages_deleted bigint NOT NULL DEFAULT 0
    CHECK (inbound_messages_deleted >= 0),
  runtime_message_events_deleted bigint NOT NULL DEFAULT 0
    CHECK (runtime_message_events_deleted >= 0),
  processed_webhooks_compacted bigint NOT NULL DEFAULT 0
    CHECK (processed_webhooks_compacted >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT runtime_storage_policy_state_completion_check CHECK (
    (phase = 'DRAINING' AND completed_at IS NULL)
    OR (phase = 'LOGICALLY_COMPACT' AND completed_at IS NOT NULL)
  )
);

COMMENT ON TABLE runtime_storage_policy_state IS
  'Resumable progress for destructive-but-policy-safe logical storage compaction. Physical file reclamation is a separate managed maintenance operation.';
