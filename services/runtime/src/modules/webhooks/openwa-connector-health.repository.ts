import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import type { EventInboxConnectorStatusResponse } from '../../contracts/event-inbox';
import type { EventInboxConnectorStatusSnapshot } from './event-inbox-connector.client';
import {
  OPENWA_CONNECTOR_JOURNAL_SCHEMA_VERSION,
  OPENWA_CONNECTOR_PROTOCOL_VERSION,
} from '../../contracts/openwa-connector';

export type OpenWAConnectorHealthState =
  | 'NOT_CONFIGURED'
  | 'AWAITING_PLUGIN'
  | 'RECOVERING'
  | 'HEALTHY'
  | 'STALE'
  | 'BLOCKED'
  | 'BINDING_MISMATCH'
  | 'UNAVAILABLE';

export interface OpenWAConnectorBinding {
  sessionId: string;
  connectorId: string;
  webhookId: string;
  generation: number;
}

export interface OpenWAConnectorAssessment {
  healthy: boolean;
  state: OpenWAConnectorHealthState;
  reason: string | null;
  remainingLeaseMs: number;
}

export function assessOpenWAConnectorReport(input: {
  connectorId: string | null;
  webhookId: string | null;
  generation: number;
  report: EventInboxConnectorStatusResponse['sessions'][number] | undefined;
  generatedAt: Date;
  requestDurationMs: number;
  staleAfterMs: number;
  blockStorageUtilization: number;
}): OpenWAConnectorAssessment {
  const unhealthy = (state: OpenWAConnectorHealthState, reason: string) => ({
    healthy: false, state, reason, remainingLeaseMs: 0,
  });
  if (!input.connectorId || !input.webhookId || input.generation < 1) {
    return unhealthy('NOT_CONFIGURED', 'binding_not_configured');
  }
  if (!input.report?.binding || input.report.binding.connectorId !== input.connectorId
    || input.report.binding.webhookId !== input.webhookId
    || input.report.binding.generation !== input.generation) {
    return unhealthy('BINDING_MISMATCH', 'desired_binding_not_synchronized');
  }
  if (!input.report.connector) {
    return unhealthy('AWAITING_PLUGIN', 'connector_not_reporting');
  }
  if (input.report.connector.connectorId !== input.connectorId) {
    return unhealthy('BINDING_MISMATCH', 'connector_identity_mismatch');
  }
  if (input.report.connector.protocolVersion !== OPENWA_CONNECTOR_PROTOCOL_VERSION) {
    return unhealthy('BLOCKED', 'connector_protocol_incompatible');
  }
  if (input.report.connector.journalSchemaVersion !== OPENWA_CONNECTOR_JOURNAL_SCHEMA_VERSION) {
    return unhealthy('BLOCKED', 'connector_journal_schema_incompatible');
  }
  if (input.report.connector.bindingGeneration !== input.generation) {
    return unhealthy('BINDING_MISMATCH', 'connector_binding_generation_mismatch');
  }
  if (input.report.connector.blockedReason) {
    return unhealthy('BLOCKED', input.report.connector.blockedReason);
  }
  if (input.report.connector.storageUtilization >= input.blockStorageUtilization) {
    return unhealthy('BLOCKED', 'connector_storage_pressure');
  }
  const remoteAgeMs = Math.max(
    0,
    input.generatedAt.valueOf() - new Date(input.report.connector.observedAt).valueOf(),
  );
  const conservativeAgeMs = remoteAgeMs + input.requestDurationMs;
  const remainingLeaseMs = Math.max(0, input.staleAfterMs - conservativeAgeMs);
  if (remainingLeaseMs === 0) {
    return unhealthy('STALE', 'connector_heartbeat_stale');
  }
  return {
    healthy: true,
    state: 'RECOVERING',
    reason: 'awaiting_healthy_heartbeat_quorum',
    remainingLeaseMs,
  };
}

@Injectable()
export class OpenWAConnectorHealthRepository {
  constructor(
    private readonly database: DatabaseService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async requireHealthyBinding(sessionId: string): Promise<OpenWAConnectorBinding> {
    const result = await this.database.query<{
      desired_webhook_id: string;
      desired_connector_id: string;
      binding_generation: string;
    }>(
      `SELECT desired_webhook_id, desired_connector_id::text, binding_generation::text
       FROM openwa_connector_sessions
       WHERE session_id = $1
         AND desired_webhook_id IS NOT NULL
         AND desired_connector_id IS NOT NULL
         AND binding_synced_at IS NOT NULL
         AND health_state = 'HEALTHY'
         AND health_lease_expires_at > now()`,
      [sessionId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('OpenWA connector binding is not healthy');
    return {
      sessionId,
      connectorId: row.desired_connector_id,
      webhookId: row.desired_webhook_id,
      generation: Number(row.binding_generation),
    };
  }

  stageBinding(
    sessionId: string,
    connectorId: string,
    webhookId: string,
  ): Promise<OpenWAConnectorBinding> {
    return this.database.transaction(async client => {
      const result = await client.query<{
        session_id: string;
        desired_connector_id: string;
        desired_webhook_id: string;
        binding_generation: string;
      }>(
        `INSERT INTO openwa_connector_sessions
           (session_id, desired_connector_id, desired_webhook_id, binding_generation,
            health_state, health_reason)
         VALUES ($1, $2::uuid, $3, 1, 'AWAITING_PLUGIN', 'binding_not_synchronized')
         ON CONFLICT (session_id) DO UPDATE SET
           desired_connector_id = EXCLUDED.desired_connector_id,
           desired_webhook_id = EXCLUDED.desired_webhook_id,
           binding_generation = openwa_connector_sessions.binding_generation
             + CASE WHEN openwa_connector_sessions.desired_webhook_id = EXCLUDED.desired_webhook_id
                 AND openwa_connector_sessions.desired_connector_id = EXCLUDED.desired_connector_id
               THEN 0 ELSE 1 END,
           binding_synced_at = CASE
             WHEN openwa_connector_sessions.desired_webhook_id = EXCLUDED.desired_webhook_id
               AND openwa_connector_sessions.desired_connector_id = EXCLUDED.desired_connector_id
               THEN openwa_connector_sessions.binding_synced_at
             ELSE NULL
           END,
           consecutive_healthy_heartbeats = CASE
             WHEN openwa_connector_sessions.desired_webhook_id = EXCLUDED.desired_webhook_id
               AND openwa_connector_sessions.desired_connector_id = EXCLUDED.desired_connector_id
               THEN openwa_connector_sessions.consecutive_healthy_heartbeats
             ELSE 0
           END,
           health_state = CASE
             WHEN openwa_connector_sessions.desired_webhook_id = EXCLUDED.desired_webhook_id
               AND openwa_connector_sessions.desired_connector_id = EXCLUDED.desired_connector_id
               THEN openwa_connector_sessions.health_state
             ELSE 'BINDING_MISMATCH'::openwa_connector_health_state
           END,
           health_reason = CASE
             WHEN openwa_connector_sessions.desired_webhook_id = EXCLUDED.desired_webhook_id
               AND openwa_connector_sessions.desired_connector_id = EXCLUDED.desired_connector_id
               THEN openwa_connector_sessions.health_reason
             ELSE 'binding_changed'
           END,
           health_lease_expires_at = CASE
             WHEN openwa_connector_sessions.desired_webhook_id = EXCLUDED.desired_webhook_id
               AND openwa_connector_sessions.desired_connector_id = EXCLUDED.desired_connector_id
               THEN openwa_connector_sessions.health_lease_expires_at
             ELSE NULL
           END,
           updated_at = now()
         RETURNING session_id::text, desired_connector_id::text,
           desired_webhook_id, binding_generation::text`,
        [sessionId, connectorId, webhookId],
      );
      const row = result.rows[0]!;
      return {
        sessionId: row.session_id,
        connectorId: row.desired_connector_id,
        webhookId: row.desired_webhook_id,
        generation: Number(row.binding_generation),
      };
    });
  }

  async markBindingSynced(binding: OpenWAConnectorBinding): Promise<void> {
    const result = await this.database.query(
      `UPDATE openwa_connector_sessions SET binding_synced_at = now(), updated_at = now()
       WHERE session_id = $1 AND desired_connector_id = $2::uuid
         AND desired_webhook_id = $3 AND binding_generation = $4`,
      [binding.sessionId, binding.connectorId, binding.webhookId, binding.generation],
    );
    if (result.rowCount !== 1) throw new Error('Connector binding changed while synchronization completed');
  }

  async applyStatus(status: EventInboxConnectorStatusSnapshot): Promise<void> {
    const reports = new Map(status.sessions.map(session => [session.sessionId, session]));
    for (const sessionId of this.config.OPENWA_ALLOWED_SESSION_IDS) {
      await this.database.transaction(async client => {
        const current = await client.query<{
          desired_connector_id: string | null;
          desired_webhook_id: string | null;
          binding_generation: string;
          heartbeat_observed_at: Date | null;
          consecutive_healthy_heartbeats: number;
        }>(
          `SELECT desired_connector_id::text, desired_webhook_id,
             binding_generation::text, heartbeat_observed_at,
             consecutive_healthy_heartbeats
           FROM openwa_connector_sessions WHERE session_id = $1 FOR UPDATE`,
          [sessionId],
        );
        const row = current.rows[0];
        if (!row) return;
        const report = reports.get(sessionId);
        const assessment = assessOpenWAConnectorReport({
          connectorId: row.desired_connector_id,
          webhookId: row.desired_webhook_id,
          generation: Number(row.binding_generation),
          report,
          generatedAt: new Date(status.generatedAt),
          requestDurationMs: status.requestDurationMs,
          staleAfterMs: this.config.EVENT_INBOX_CONNECTOR_STALE_AFTER_MS,
          blockStorageUtilization: this.config.EVENT_INBOX_CONNECTOR_BLOCK_STORAGE_UTILIZATION,
        });
        const isNewHealthyHeartbeat = assessment.healthy
          && report?.connector
          && row.heartbeat_observed_at?.toISOString() !== report.connector.observedAt;
        const consecutive = assessment.healthy
          ? isNewHealthyHeartbeat
            ? row.consecutive_healthy_heartbeats + 1
            : row.consecutive_healthy_heartbeats
          : 0;
        const recovered = assessment.healthy
          && consecutive >= this.config.EVENT_INBOX_CONNECTOR_RECOVERY_HEARTBEATS;
        const healthState: OpenWAConnectorHealthState = recovered ? 'HEALTHY' : assessment.state;
        const observedAt = report?.connector ? new Date(report.connector.observedAt) : null;
        const leaseExpiresAt = recovered && observedAt
          ? new Date(status.receivedAt.valueOf() + assessment.remainingLeaseMs)
          : null;
        await client.query(
          `UPDATE openwa_connector_sessions SET
             connector_id = $2::uuid,
             plugin_version = $3,
             protocol_version = $4,
             journal_schema_version = $5,
             reported_binding_generation = $6,
             pending_count = $7,
             oldest_pending_seconds = $8,
             storage_utilization = $9,
             blocked_reason = $10,
             heartbeat_observed_at = $11,
             last_polled_at = now(),
             last_poll_error = NULL,
             consecutive_healthy_heartbeats = $12,
             health_state = $13::openwa_connector_health_state,
             health_reason = $14,
             health_lease_expires_at = $15,
             updated_at = now()
           WHERE session_id = $1`,
          [
            sessionId,
            report?.connector?.connectorId ?? null,
            report?.connector?.pluginVersion ?? null,
            report?.connector?.protocolVersion ?? null,
            report?.connector?.journalSchemaVersion ?? null,
            report?.connector?.bindingGeneration ?? null,
            report?.connector?.pendingCount ?? null,
            report?.connector?.oldestPendingSeconds ?? null,
            report?.connector?.storageUtilization ?? null,
            report?.connector?.blockedReason ?? null,
            observedAt,
            consecutive,
            healthState,
            recovered ? null : assessment.reason,
            leaseExpiresAt,
          ],
        );
      });
    }
  }

  async recordPollFailure(error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    await this.database.query(
      `UPDATE openwa_connector_sessions SET
         last_polled_at = now(), last_poll_error = left($2, 512),
         consecutive_healthy_heartbeats = CASE
           WHEN health_state = 'HEALTHY' AND health_lease_expires_at > now()
             THEN consecutive_healthy_heartbeats
           ELSE 0
         END,
         health_state = CASE
           WHEN health_state = 'HEALTHY' AND health_lease_expires_at > now()
             THEN health_state
           ELSE 'UNAVAILABLE'::openwa_connector_health_state
         END,
         health_reason = CASE
           WHEN health_state = 'HEALTHY' AND health_lease_expires_at > now()
             THEN health_reason
           ELSE 'event_inbox_unavailable'
         END,
         updated_at = now()
       WHERE session_id = ANY($1::text[])`,
      [this.config.OPENWA_ALLOWED_SESSION_IDS, reason],
    );
  }

}
