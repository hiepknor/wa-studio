CREATE INDEX IF NOT EXISTS idx_runtime_mutation_receipts_retention
  ON runtime_mutation_receipts (accepted_at, operation_type, idempotency_key);
