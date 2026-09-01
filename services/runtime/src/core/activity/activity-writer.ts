import type { PoolClient } from 'pg';
import { correlationContext } from '../observability/correlation-context';

export type ActivityCategory = 'RUN' | 'CAMPAIGN' | 'SYNC' | 'SESSION';
export type ActivitySeverity = 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR';
export type ActivityOrigin = 'STUDIO' | 'RUNTIME' | 'GATEWAY';

export interface AppendActivityEventInput {
  sessionId: string;
  eventType: string;
  category: ActivityCategory;
  severity: ActivitySeverity;
  origin: ActivityOrigin;
  subjectType: string;
  subjectId: string;
  subjectLabelSnapshot: string;
  campaignId?: string;
  runId?: string;
  syncRunId?: string;
  groupId?: string;
  metadata?: Record<string, unknown>;
  dedupeKey?: string;
  occurredAt?: Date;
}

export async function appendActivityEvent(
  client: PoolClient,
  input: AppendActivityEventInput,
): Promise<void> {
  const context = correlationContext();
  const correlationId = typeof context.requestId === 'string'
    ? context.requestId
    : typeof context.queueJobId === 'string'
      ? context.queueJobId
      : undefined;
  await client.query(
    `INSERT INTO activity_events
       (session_id, event_type, category, severity, origin, subject_type, subject_id,
        subject_label_snapshot, campaign_id, run_id, sync_run_id, group_id,
        correlation_id, metadata, dedupe_key, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      input.sessionId,
      input.eventType,
      input.category,
      input.severity,
      input.origin,
      input.subjectType,
      input.subjectId,
      input.subjectLabelSnapshot,
      input.campaignId ?? null,
      input.runId ?? null,
      input.syncRunId ?? null,
      input.groupId ?? null,
      correlationId ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.dedupeKey ?? null,
      input.occurredAt ?? new Date(),
    ],
  );
}
