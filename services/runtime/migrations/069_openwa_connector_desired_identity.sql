ALTER TABLE openwa_connector_sessions
  ADD COLUMN desired_connector_id uuid;

UPDATE openwa_connector_sessions
SET desired_connector_id = connector_id
WHERE desired_webhook_id IS NOT NULL
  AND connector_id IS NOT NULL;

UPDATE openwa_connector_sessions
SET desired_webhook_id = NULL,
    desired_connector_id = NULL,
    binding_generation = 0,
    binding_synced_at = NULL,
    consecutive_healthy_heartbeats = 0,
    health_state = 'NOT_CONFIGURED',
    health_reason = 'connector_identity_requires_reconciliation',
    health_lease_expires_at = NULL,
    updated_at = now()
WHERE desired_webhook_id IS NOT NULL
  AND desired_connector_id IS NULL;

ALTER TABLE openwa_connector_sessions
  ADD CONSTRAINT openwa_connector_desired_identity_complete CHECK (
    (desired_webhook_id IS NULL AND desired_connector_id IS NULL AND binding_generation = 0)
    OR (desired_webhook_id IS NOT NULL AND desired_connector_id IS NOT NULL AND binding_generation > 0)
  );
