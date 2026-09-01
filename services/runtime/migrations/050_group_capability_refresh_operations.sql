ALTER TABLE gateway_group_reconciliation_intents
  ADD COLUMN IF NOT EXISTS priority smallint NOT NULL DEFAULT 5;

ALTER TABLE gateway_group_reconciliation_intents
  DROP CONSTRAINT IF EXISTS gateway_group_reconciliation_intents_priority_check;

ALTER TABLE gateway_group_reconciliation_intents
  ADD CONSTRAINT gateway_group_reconciliation_intents_priority_check
  CHECK (priority BETWEEN 1 AND 10);

CREATE INDEX IF NOT EXISTS idx_gateway_group_intents_priority_dispatch
  ON gateway_group_reconciliation_intents
    (priority, next_attempt_at, not_before, last_requested_at)
  WHERE status IN ('PENDING', 'RETRY');

UPDATE gateway_group_reconciliation_intents intents
SET priority = LEAST(intents.priority, 1),
    reasons = CASE
      WHEN 'manual.capability_refresh' = ANY(intents.reasons) THEN intents.reasons
      ELSE array_append(intents.reasons, 'manual.capability_refresh')
    END,
    updated_at = now()
FROM gateway_groups groups
WHERE groups.session_id = intents.session_id
  AND groups.id = intents.group_id
  AND groups.is_active = true
  AND groups.capability_invalidated_at IS NOT NULL
  AND groups.send_capability_reason = 'MANUAL_REFRESH';

INSERT INTO gateway_group_reconciliation_intents
  (session_id, group_id, reasons, priority, not_before, next_attempt_at)
SELECT groups.session_id, groups.id,
  ARRAY[CASE
    WHEN groups.send_capability_reason = 'MANUAL_REFRESH' THEN 'manual.capability_refresh'
    WHEN groups.send_capability_reason = 'GATEWAY_PERMISSION_DENIED' THEN 'send.permission_denied'
    ELSE 'capability.invalidated'
  END],
  CASE WHEN groups.send_capability_reason = 'MANUAL_REFRESH' THEN 1 ELSE 5 END,
  now(), now()
FROM gateway_groups groups
WHERE groups.is_active = true
  AND groups.capability_invalidated_at IS NOT NULL
ON CONFLICT (session_id, group_id) DO NOTHING;

UPDATE gateway_groups
SET capability_refresh_attempt_count = 0,
    capability_refresh_next_attempt_at = now(),
    capability_refresh_lease_token = NULL,
    capability_refresh_lease_expires_at = NULL,
    capability_refresh_error = NULL
WHERE capability_invalidated_at IS NOT NULL;

SELECT pg_notify('wa_runtime_gateway_work', 'group-reconciliation');
