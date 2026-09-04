DROP INDEX IF EXISTS idx_message_jobs_retention;
CREATE INDEX idx_message_jobs_retention
  ON message_jobs (updated_at, id)
  WHERE status IN (
    'ACCEPTED','SENT','DELIVERED','READ','FAILED','DRY_RUN_COMPLETED','CANCELLED'
  );

DROP INDEX IF EXISTS idx_webhook_events_retention;
CREATE INDEX idx_webhook_events_retention
  ON webhook_events (COALESCE(processed_at, received_at), id)
  WHERE processing_state = 'PROCESSED';

CREATE INDEX IF NOT EXISTS idx_webhook_events_dead_age
  ON webhook_events (COALESCE(dead_at, received_at), id)
  WHERE processing_state = 'DEAD';

CREATE INDEX IF NOT EXISTS idx_campaign_deliveries_unknown_run
  ON campaign_deliveries (run_id, message_job_id)
  WHERE status = 'UNKNOWN';

UPDATE runtime_webhook_spool_usage usage
SET stored_events = actual.stored_events,
    stored_bytes = actual.stored_bytes,
    updated_at = now()
FROM (
  SELECT count(*)::bigint AS stored_events,
    COALESCE(sum(storage_bytes), 0)::bigint AS stored_bytes
  FROM webhook_events
  WHERE processing_state IN ('PENDING', 'PROCESSING', 'RETRY', 'DEAD')
) actual
WHERE usage.singleton = true;
