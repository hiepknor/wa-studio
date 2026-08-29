import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { MessageStatusProjectionService } from '../messages/message-status-projection.service';
import { normalizeOpenWAWebhook } from './webhook-normalizer';
import { RuntimeEventRepository } from './runtime-event.repository';
import { WebhookRepository } from './webhook.repository';
import { ContactMessageObserverService } from '../contacts/contact-message-observer.service';

@Injectable()
export class WebhookProcessorService {
  constructor(
    private readonly database: DatabaseService,
    private readonly webhooks: WebhookRepository,
    private readonly runtimeEvents: RuntimeEventRepository,
    private readonly messageStatuses: MessageStatusProjectionService,
    private readonly contacts: ContactMessageObserverService,
  ) {}

  async process(idempotencyKey: string): Promise<unknown> {
    const claim = await this.webhooks.claimForProcessing(idempotencyKey);
    if (!claim) return { skipped: true };
    const { envelope, leaseToken } = claim;
    try {
      const runtimeEvent = normalizeOpenWAWebhook(envelope);
      const outcome = await this.database.transaction(async client => {
        if (!await this.webhooks.lockProcessingLease(client, envelope.idempotencyKey, leaseToken)) {
          return null;
        }
        await this.runtimeEvents.storeInTransaction(client, runtimeEvent);
        if (envelope.event === 'message.received') {
          const senderId = String(envelope.data.author ?? envelope.data.from ?? '');
          const contact = typeof envelope.data.contact === 'object' && envelope.data.contact !== null
            ? envelope.data.contact as Record<string, unknown>
            : null;
          const pushName = typeof contact?.pushName === 'string' ? contact.pushName : null;
          if (senderId && pushName) {
            await this.contacts.enqueue(client, {
              eventId: envelope.idempotencyKey,
              sessionId: envelope.sessionId,
              senderId,
              pushName,
              observedAt: runtimeEvent.occurredAt,
            });
          }
        }
        const projection = await this.messageStatuses.projectEventInTransaction(
          client,
          envelope.idempotencyKey,
        );
        if (!await this.webhooks.markProcessedInTransaction(client, envelope.idempotencyKey, leaseToken)) {
          throw new Error(`Webhook processing lease changed while locked: ${envelope.idempotencyKey}`);
        }
        return projection;
      });
      if (!outcome) {
        return { skipped: true, lostOwnership: true };
      }
      return {
        statusUpdated: outcome.statusAdvanced,
        projectionPending: outcome.state === 'PENDING',
      };
    } catch (error) {
      await this.webhooks.markFailed(
        envelope.idempotencyKey,
        leaseToken,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }
}
