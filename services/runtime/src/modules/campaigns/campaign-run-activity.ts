import type { PoolClient } from 'pg';
import {
  appendActivityEvent,
  type ActivityOrigin,
  type ActivitySeverity,
} from '../../core/activity/activity-writer';

interface CampaignRunActivityInput {
  runId: string;
  eventType: string;
  severity: ActivitySeverity;
  origin: ActivityOrigin;
  metadata?: Record<string, unknown>;
  dedupeKey?: string;
}

export async function appendCampaignRunActivity(
  client: PoolClient,
  input: CampaignRunActivityInput,
): Promise<void> {
  const result = await client.query<{
    campaign_id: string;
    campaign_name_snapshot: string;
    execution_mode: string;
    session_id: string;
    status: string;
    status_reason: string | null;
  }>(
    `SELECT campaign_id, campaign_name_snapshot, execution_mode, session_id, status, status_reason
     FROM campaign_runs WHERE id = $1`,
    [input.runId],
  );
  const run = result.rows[0];
  if (!run) return;
  await appendActivityEvent(client, {
    sessionId: run.session_id,
    eventType: input.eventType,
    category: 'RUN',
    severity: input.severity,
    origin: input.origin,
    subjectType: 'CAMPAIGN_RUN',
    subjectId: input.runId,
    subjectLabelSnapshot: run.campaign_name_snapshot,
    campaignId: run.campaign_id,
    runId: input.runId,
    metadata: {
      executionMode: run.execution_mode,
      status: run.status,
      ...(run.status_reason ? { statusReason: run.status_reason } : {}),
      ...input.metadata,
    },
    dedupeKey: input.dedupeKey,
  });
}
