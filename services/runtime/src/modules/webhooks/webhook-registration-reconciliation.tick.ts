import { Injectable, Logger } from '@nestjs/common';
import { OpenWAClient } from '../../integrations/openwa/openwa.client';
import { EventInboxConnectorClient } from './event-inbox-connector.client';
import { OpenWAConnectorHealthRepository } from './openwa-connector-health.repository';

export const RUNTIME_OPENWA_WEBHOOK_EVENTS = [
  'message.received',
  'message.sent',
  'message.ack',
  'message.failed',
  'session.status',
  'session.restriction',
  'group.join',
  'group.leave',
  'group.update',
] as const;

export interface WebhookRegistrationReconciliationOptions {
  enabled: boolean;
  callbackUrl: string | null;
  secret: string;
  allowedSessionIds: string[];
}

interface ReconciliationCounts {
  created: number;
  updated: number;
  deleted: number;
}

@Injectable()
export class WebhookRegistrationReconciliationTick {
  private readonly logger = new Logger(WebhookRegistrationReconciliationTick.name);

  constructor(
    private readonly openwa: OpenWAClient,
    private readonly options: WebhookRegistrationReconciliationOptions,
    private readonly connector?: EventInboxConnectorClient,
    private readonly connectorHealth?: OpenWAConnectorHealthRepository,
  ) {}

  async run(): Promise<void> {
    if (!this.options.enabled) return;
    if (!this.options.callbackUrl) {
      throw new Error('Webhook reconciliation is enabled without a callback URL');
    }

    const totals: ReconciliationCounts = { created: 0, updated: 0, deleted: 0 };
    let failed = 0;
    const connectorStatus = this.connector && this.connectorHealth
      ? this.connector.status()
      : null;
    for (const sessionId of this.options.allowedSessionIds) {
      try {
        const counts = await this.openwa.reconcileWebhookRegistration({
          sessionId,
          url: this.options.callbackUrl,
          events: [...RUNTIME_OPENWA_WEBHOOK_EVENTS],
          secret: this.options.secret,
          retryCount: 3,
        });
        totals.created += counts.created;
        totals.updated += counts.updated;
        totals.deleted += counts.deleted;
        if (this.connector && this.connectorHealth && connectorStatus) {
          const status = await connectorStatus;
          const connectorId = status.sessions.find(session => session.sessionId === sessionId)
            ?.connector?.connectorId;
          if (!connectorId) throw new Error('No reporting connector is available for this session');
          const binding = await this.connectorHealth.stageBinding(
            sessionId,
            connectorId,
            counts.webhookId,
          );
          const synchronized = await this.connector.setBinding(binding);
          if (synchronized.webhookId !== binding.webhookId
            || synchronized.generation !== binding.generation) {
            throw new Error('Event Inbox connector binding acknowledgement did not match the desired binding');
          }
          await this.connectorHealth.markBindingSynced(binding);
        }
      } catch {
        failed += 1;
      }
    }

    const details = {
      event: 'openwa.webhook_registration.reconciled',
      sessions: this.options.allowedSessionIds.length,
      failed,
      ...totals,
    };
    if (failed > 0) {
      this.logger.warn(details);
      throw new Error(`OpenWA webhook registration reconciliation failed for ${failed} session(s)`);
    }
    this.logger.log(details);
  }

}
