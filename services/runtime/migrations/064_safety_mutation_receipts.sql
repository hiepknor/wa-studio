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
    'OPENWA_SAFETY_PROFILE_CHANGE'
  ));
