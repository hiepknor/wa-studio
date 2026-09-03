DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'openwa_safety_scopes'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%MANUAL_BLOCKED%'
      AND pg_get_constraintdef(oid) ILIKE '%manual_blocked_at%'
  LOOP
    EXECUTE format('ALTER TABLE openwa_safety_scopes DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE openwa_safety_scopes
  ADD COLUMN IF NOT EXISTS manual_block_reason text;

UPDATE openwa_safety_scopes
SET manual_block_reason = COALESCE(reason_code, 'OPERATOR_BLOCKED'),
    circuit_state = 'CLOSED',
    reason_code = NULL,
    updated_at = now()
WHERE circuit_state = 'MANUAL_BLOCKED';

ALTER TABLE openwa_safety_scopes
  ADD CONSTRAINT openwa_safety_scopes_manual_block_reason_length
  CHECK (manual_block_reason IS NULL OR char_length(manual_block_reason) BETWEEN 1 AND 200);

COMMENT ON COLUMN openwa_safety_scopes.manual_blocked_at IS
  'Durable admission hold layered over, and independent from, the automatic circuit state.';

COMMENT ON COLUMN openwa_safety_scopes.manual_block_reason IS
  'Operator or system reason for the independent admission hold.';
