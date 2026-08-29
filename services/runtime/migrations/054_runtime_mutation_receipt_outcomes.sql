ALTER TABLE runtime_mutation_receipts
  ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT 'SUCCEEDED',
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS error_message text,
  ADD COLUMN IF NOT EXISTS error_details jsonb;

ALTER TABLE runtime_mutation_receipts
  DROP CONSTRAINT IF EXISTS runtime_mutation_receipts_outcome_check;

ALTER TABLE runtime_mutation_receipts
  ADD CONSTRAINT runtime_mutation_receipts_outcome_check
  CHECK (
    (outcome = 'SUCCEEDED'
      AND error_code IS NULL AND error_message IS NULL AND error_details IS NULL)
    OR
    (outcome = 'REJECTED'
      AND char_length(error_code) BETWEEN 1 AND 200
      AND char_length(error_message) BETWEEN 1 AND 1000)
  );
