import type { QueryResult, QueryResultRow } from 'pg';
import type { RuntimeConfig } from '../config/runtime-config';

interface QueryExecutor {
  query<T extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
}

export type RuntimeStoragePolicyPhase = 'NOT_APPLICABLE' | 'DRAINING' | 'LOGICALLY_COMPACT';

export interface RuntimeStoragePolicySnapshot {
  version: number;
  phase: RuntimeStoragePolicyPhase;
  inboundMessagesDeleted: number;
  runtimeMessageEventsDeleted: number;
  processedWebhooksCompacted: number;
  completedAt: Date | null;
}

const policyActive = (config: Pick<RuntimeConfig,
  'RUNTIME_MESSAGE_STORAGE_MODE' | 'RUNTIME_COMPACT_PROCESSED_WEBHOOK_PAYLOAD_ENABLED'>): boolean =>
  config.RUNTIME_MESSAGE_STORAGE_MODE === 'disabled'
    || config.RUNTIME_COMPACT_PROCESSED_WEBHOOK_PAYLOAD_ENABLED;

export async function readRuntimeStoragePolicySnapshot(
  executor: QueryExecutor,
  config: Pick<RuntimeConfig,
    | 'RUNTIME_STORAGE_POLICY_VERSION'
    | 'RUNTIME_MESSAGE_STORAGE_MODE'
    | 'RUNTIME_COMPACT_PROCESSED_WEBHOOK_PAYLOAD_ENABLED'>,
): Promise<RuntimeStoragePolicySnapshot> {
  const result = await executor.query<{
    policy_version: number;
    phase: 'DRAINING' | 'LOGICALLY_COMPACT';
    inbound_messages_deleted: string;
    runtime_message_events_deleted: string;
    processed_webhooks_compacted: string;
    completed_at: Date | null;
  }>(
    `SELECT policy_version, phase, inbound_messages_deleted::text,
       runtime_message_events_deleted::text, processed_webhooks_compacted::text, completed_at
     FROM runtime_storage_policy_state WHERE singleton = true`,
  );
  const row = result.rows[0];
  if (!row) {
    return {
      version: Number(config.RUNTIME_STORAGE_POLICY_VERSION),
      phase: policyActive(config) ? 'DRAINING' : 'NOT_APPLICABLE',
      inboundMessagesDeleted: 0,
      runtimeMessageEventsDeleted: 0,
      processedWebhooksCompacted: 0,
      completedAt: null,
    };
  }
  return {
    version: row.policy_version,
    phase: row.phase,
    inboundMessagesDeleted: Number(row.inbound_messages_deleted),
    runtimeMessageEventsDeleted: Number(row.runtime_message_events_deleted),
    processedWebhooksCompacted: Number(row.processed_webhooks_compacted),
    completedAt: row.completed_at,
  };
}
