ALTER TABLE openwa_safety_scopes
  ADD COLUMN IF NOT EXISTS outbound_paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS outbound_pause_reason text;

ALTER TABLE openwa_safety_scopes
  ADD CONSTRAINT openwa_safety_scopes_outbound_pause_pair
  CHECK ((outbound_paused_at IS NULL) = (outbound_pause_reason IS NULL)),
  ADD CONSTRAINT openwa_safety_scopes_outbound_pause_reason_length
  CHECK (outbound_pause_reason IS NULL OR char_length(outbound_pause_reason) BETWEEN 1 AND 200);

ALTER TABLE runtime_mutation_receipts
  DROP CONSTRAINT IF EXISTS runtime_mutation_receipts_operation_type_check;

ALTER TABLE runtime_mutation_receipts
  ADD CONSTRAINT runtime_mutation_receipts_operation_type_check
  CHECK (operation_type IN (
    'SESSION_SYNC',
    'GROUP_CAPABILITY_REFRESH',
    'CAMPAIGN_RUN_PAUSE',
    'CAMPAIGN_RUN_RESUME',
    'CAMPAIGN_RUN_CANCEL',
    'OPENWA_WORKSPACE_BLOCK',
    'OPENWA_WORKSPACE_RESUME',
    'OPENWA_SESSION_BLOCK',
    'OPENWA_SESSION_RESUME',
    'OPENWA_SAFETY_PROFILE_CHANGE',
    'OPENWA_OUTBOUND_PAUSE',
    'OPENWA_OUTBOUND_RESUME'
  ));

COMMENT ON COLUMN openwa_safety_scopes.outbound_paused_at IS
  'Durable session-scoped hold for message sends only; protected reads and reconciliation continue.';

COMMENT ON COLUMN openwa_safety_scopes.outbound_pause_reason IS
  'Operator reason for the message-only outbound hold.';
