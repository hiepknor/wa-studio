import type { PoolClient } from 'pg';
import { appendActivityEvent, type ActivityOrigin, type ActivitySeverity } from '../../core/activity/activity-writer';

export async function appendGatewaySyncActivity(
  client: PoolClient,
  input: {
    syncRunId: string;
    eventType: string;
    severity: ActivitySeverity;
    origin: ActivityOrigin;
    metadata?: Record<string, unknown>;
    dedupeKey?: string;
  },
): Promise<void> {
  const result = await client.query<{
    session_id: string;
    session_name: string;
    sync_type: string;
    status: string;
  }>(
    `SELECT sr.session_id, gs.name AS session_name, sr.sync_type, sr.status
     FROM sync_runs sr
     JOIN gateway_sessions gs ON gs.id = sr.session_id
     WHERE sr.id = $1`,
    [input.syncRunId],
  );
  const sync = result.rows[0];
  if (!sync) return;
  await appendActivityEvent(client, {
    sessionId: sync.session_id,
    eventType: input.eventType,
    category: 'SYNC',
    severity: input.severity,
    origin: input.origin,
    subjectType: 'SYNC_RUN',
    subjectId: input.syncRunId,
    subjectLabelSnapshot: `${sync.sync_type === 'FULL' ? 'Full sync' : 'Incremental sync'} · ${sync.session_name}`,
    syncRunId: input.syncRunId,
    metadata: { syncType: sync.sync_type, status: sync.status, ...input.metadata },
    dedupeKey: input.dedupeKey,
  });
}
