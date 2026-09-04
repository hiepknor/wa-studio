import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { RuntimeConfig } from '../config/runtime-config';

interface QueryExecutor {
  query<T extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
}

export interface RuntimeWebhookSpoolUsage {
  storedEvents: number;
  storedBytes: number;
}

export interface RuntimeWebhookSpoolSnapshot extends RuntimeWebhookSpoolUsage {
  maxStoredEvents: number;
  maxStoredBytes: number;
  activeEvents: number;
  deadEvents: number;
  oldestActiveAgeSeconds: number | null;
  oldestDeadAgeSeconds: number | null;
  utilization: number;
  admissionAvailable: boolean;
}

export function runtimeWebhookSpoolAdmission(
  usage: RuntimeWebhookSpoolUsage,
  config: Pick<RuntimeConfig,
    'RUNTIME_WEBHOOK_SPOOL_MAX_EVENTS' | 'RUNTIME_WEBHOOK_SPOOL_MAX_BYTES'>,
  incomingBytes: number,
): boolean {
  return usage.storedEvents + 1 <= config.RUNTIME_WEBHOOK_SPOOL_MAX_EVENTS
    && usage.storedBytes + incomingBytes <= config.RUNTIME_WEBHOOK_SPOOL_MAX_BYTES;
}

export async function lockRuntimeWebhookSpoolUsage(
  client: PoolClient,
): Promise<RuntimeWebhookSpoolUsage> {
  const result = await client.query<{ stored_events: string; stored_bytes: string }>(
    `SELECT stored_events::text, stored_bytes::text
     FROM runtime_webhook_spool_usage WHERE singleton = true FOR UPDATE`,
  );
  const row = result.rows[0];
  if (!row) throw new Error('Runtime webhook spool usage ledger is unavailable');
  return { storedEvents: Number(row.stored_events), storedBytes: Number(row.stored_bytes) };
}

export async function incrementRuntimeWebhookSpoolUsage(
  client: PoolClient,
  storageBytes: number,
): Promise<void> {
  await client.query(
    `UPDATE runtime_webhook_spool_usage SET
       stored_events = stored_events + 1,
       stored_bytes = stored_bytes + $1,
       updated_at = now()
     WHERE singleton = true`,
    [storageBytes],
  );
}

export async function decrementRuntimeWebhookSpoolUsage(
  client: PoolClient,
  storedEvents: number,
  storedBytes: number,
): Promise<void> {
  if (storedEvents === 0) return;
  const result = await client.query(
    `UPDATE runtime_webhook_spool_usage SET
       stored_events = stored_events - $1,
       stored_bytes = stored_bytes - $2,
       updated_at = now()
     WHERE singleton = true
       AND stored_events >= $1 AND stored_bytes >= $2`,
    [storedEvents, storedBytes],
  );
  if (result.rowCount !== 1) throw new Error('Runtime webhook spool usage ledger underflow');
}

export async function readRuntimeWebhookSpoolSnapshot(
  executor: QueryExecutor,
  config: Pick<RuntimeConfig,
    | 'RUNTIME_HTTP_BODY_MAX_BYTES'
    | 'RUNTIME_WEBHOOK_SPOOL_MAX_EVENTS'
    | 'RUNTIME_WEBHOOK_SPOOL_MAX_BYTES'>,
): Promise<RuntimeWebhookSpoolSnapshot> {
  const result = await executor.query<{
    stored_events: string;
    stored_bytes: string;
    dead_events: string;
    oldest_active_age_seconds: string | null;
    oldest_dead_age_seconds: string | null;
  }>(
    `SELECT usage.stored_events::text, usage.stored_bytes::text,
       (SELECT count(*)::text FROM webhook_events
        WHERE processing_state = 'DEAD') AS dead_events,
       EXTRACT(EPOCH FROM now() - active.oldest_received_at)::text AS oldest_active_age_seconds,
       (SELECT EXTRACT(EPOCH FROM now() - min(COALESCE(dead_at, received_at)))::text
        FROM webhook_events WHERE processing_state = 'DEAD') AS oldest_dead_age_seconds
     FROM runtime_webhook_spool_usage usage
     CROSS JOIN LATERAL (
       SELECT min(received_at) AS oldest_received_at FROM (
         SELECT received_at FROM webhook_events
         WHERE processing_state IN ('PENDING', 'RETRY')
         UNION ALL
         SELECT received_at FROM webhook_events
         WHERE processing_state = 'PROCESSING'
       ) pending
     ) active
     WHERE usage.singleton = true`,
  );
  const row = result.rows[0];
  if (!row) throw new Error('Runtime webhook spool usage ledger is unavailable');
  const storedEvents = Number(row.stored_events);
  const storedBytes = Number(row.stored_bytes);
  const deadEvents = Number(row.dead_events);
  return {
    storedEvents,
    storedBytes,
    maxStoredEvents: config.RUNTIME_WEBHOOK_SPOOL_MAX_EVENTS,
    maxStoredBytes: config.RUNTIME_WEBHOOK_SPOOL_MAX_BYTES,
    activeEvents: Math.max(0, storedEvents - deadEvents),
    deadEvents,
    oldestActiveAgeSeconds: row.oldest_active_age_seconds === null
      ? null : Math.max(0, Math.round(Number(row.oldest_active_age_seconds))),
    oldestDeadAgeSeconds: row.oldest_dead_age_seconds === null
      ? null : Math.max(0, Math.round(Number(row.oldest_dead_age_seconds))),
    utilization: Math.max(
      storedEvents / config.RUNTIME_WEBHOOK_SPOOL_MAX_EVENTS,
      storedBytes / config.RUNTIME_WEBHOOK_SPOOL_MAX_BYTES,
    ),
    admissionAvailable: runtimeWebhookSpoolAdmission(
      { storedEvents, storedBytes },
      config,
      config.RUNTIME_HTTP_BODY_MAX_BYTES,
    ),
  };
}
