import { describe, expect, it, vi } from 'vitest';
import type { MessageStatusProjectionService } from '../../src/modules/messages/message-status-projection.service';
import type { RuntimeEventRepository } from '../../src/modules/webhooks/runtime-event.repository';
import { WebhookProcessorService } from '../../src/modules/webhooks/webhook-processor.service';
import type { OpenWAWebhookEnvelope, WebhookRepository } from '../../src/modules/webhooks/webhook.repository';
import type { ContactMessageObserverService } from '../../src/modules/contacts/contact-message-observer.service';
import type { DatabaseService } from '../../src/core/database/database.service';
import type { MessageDeliveryEvidenceService } from '../../src/modules/messages/message-delivery-evidence.service';

const envelope: OpenWAWebhookEnvelope = {
  event: 'message.ack', timestamp: '2026-08-11T00:00:00.000Z', sessionId: 'session-1',
  idempotencyKey: 'event-1', deliveryId: 'delivery-1',
  data: { messageId: 'message-1', status: 'delivered' },
};
const claim = { envelope, leaseToken: 'lease-1', attemptNumber: 1 };
const client = {} as never;

const databaseMock = () => ({
  transaction: vi.fn(async (operation: (transactionClient: never) => Promise<unknown>) => operation(client)),
});

describe('WebhookProcessorService', () => {
  it('projects connector evidence through the authoritative attempt state machine', async () => {
    const evidence = {
      protocolVersion: 1,
      eventId: 'f698b26a-b23d-414d-be67-e09b127d6cc8',
      commandId: '760ba9a3-606c-4ceb-83ba-d6ea46e73fc1',
      attemptId: '9551a035-740f-4c01-b234-b1306de2fba8',
      sessionId: '91f27e51-fd00-4c07-bfbf-0ddf11a02af6',
      sequence: 1,
      kind: 'COMMAND_RECEIVED',
      openwaMessageId: null,
      deliveryStatus: 'PENDING',
      errorClass: null,
      errorCode: null,
      bindingGeneration: 1,
      pluginVersion: '1.0.0',
      occurredAt: '2026-08-31T10:00:00.000Z',
      payloadSha256: 'b'.repeat(64),
    };
    const connectorEnvelope: OpenWAWebhookEnvelope = {
      event: 'wa-studio.connector.evidence',
      timestamp: evidence.occurredAt,
      sessionId: evidence.sessionId,
      idempotencyKey: `${evidence.eventId}_webhook-1`,
      deliveryId: evidence.eventId,
      data: evidence,
    };
    const database = databaseMock();
    const webhooks = {
      claimForProcessing: vi.fn().mockResolvedValue({ ...claim, envelope: connectorEnvelope }),
      lockProcessingLease: vi.fn().mockResolvedValue(true),
      markProcessedInTransaction: vi.fn().mockResolvedValue(true),
      markFailed: vi.fn(),
    };
    const messageStatuses = { projectEventInTransaction: vi.fn() };
    const connectorEvidence = {
      projectInTransaction: vi.fn().mockResolvedValue({
        state: 'APPLIED', statusAdvanced: false, jobId: evidence.commandId,
      }),
    };
    const processor = new WebhookProcessorService(
      database as unknown as DatabaseService,
      webhooks as unknown as WebhookRepository,
      { storeInTransaction: vi.fn().mockResolvedValue(true) } as unknown as RuntimeEventRepository,
      messageStatuses as unknown as MessageStatusProjectionService,
      {} as ContactMessageObserverService,
      connectorEvidence as unknown as MessageDeliveryEvidenceService,
    );

    await processor.process(connectorEnvelope.idempotencyKey);

    expect(connectorEvidence.projectInTransaction).toHaveBeenCalledWith(client, evidence);
    expect(messageStatuses.projectEventInTransaction).not.toHaveBeenCalled();
    expect(webhooks.markProcessedInTransaction).toHaveBeenCalledOnce();
  });

  it('persists, reconciles and marks a claimed event processed', async () => {
    const database = databaseMock();
    const webhooks = {
      claimForProcessing: vi.fn().mockResolvedValue(claim),
      lockProcessingLease: vi.fn().mockResolvedValue(true),
      markProcessedInTransaction: vi.fn().mockResolvedValue(true), markFailed: vi.fn(),
    };
    const runtimeEvents = { storeInTransaction: vi.fn().mockResolvedValue(true) };
    const messageStatuses = {
      projectEventInTransaction: vi.fn().mockResolvedValue({ state: 'APPLIED', statusAdvanced: true }),
    };
    const processor = new WebhookProcessorService(
      database as unknown as DatabaseService,
      webhooks as unknown as WebhookRepository,
      runtimeEvents as unknown as RuntimeEventRepository,
      messageStatuses as unknown as MessageStatusProjectionService,
      {} as ContactMessageObserverService,
    );

    await processor.process(envelope.idempotencyKey);

    expect(runtimeEvents.storeInTransaction).toHaveBeenCalledOnce();
    expect(messageStatuses.projectEventInTransaction).toHaveBeenCalledWith(
      client, envelope.idempotencyKey,
    );
    expect(webhooks.markProcessedInTransaction).toHaveBeenCalledWith(
      client, envelope.idempotencyKey, claim.leaseToken,
    );
    expect(webhooks.markFailed).not.toHaveBeenCalled();
  });

  it('records durable retry state when processing fails', async () => {
    const database = databaseMock();
    const webhooks = {
      claimForProcessing: vi.fn().mockResolvedValue(claim),
      lockProcessingLease: vi.fn().mockResolvedValue(true), markProcessedInTransaction: vi.fn(),
      markFailed: vi.fn().mockResolvedValue('RETRY'),
    };
    const runtimeEvents = { storeInTransaction: vi.fn().mockRejectedValue(new Error('database unavailable')) };
    const processor = new WebhookProcessorService(
      database as unknown as DatabaseService,
      webhooks as unknown as WebhookRepository,
      runtimeEvents as unknown as RuntimeEventRepository,
      {} as MessageStatusProjectionService,
      {} as ContactMessageObserverService,
    );

    await expect(processor.process(envelope.idempotencyKey)).rejects.toThrow('database unavailable');
    expect(webhooks.markFailed).toHaveBeenCalledWith(
      envelope.idempotencyKey,
      claim.leaseToken,
      'database unavailable',
    );
    expect(webhooks.markProcessedInTransaction).not.toHaveBeenCalled();
  });

  it('observes only the normalized sender and push name from an inbound message', async () => {
    const database = databaseMock();
    const messageEnvelope: OpenWAWebhookEnvelope = {
      ...envelope,
      event: 'message.received',
      data: {
        id: 'inbound-1', author: 'sender@lid', from: 'group@g.us',
        contact: { pushName: ' Sender name ', phone: 'must-not-be-forwarded' },
      },
    };
    const webhooks = {
      claimForProcessing: vi.fn().mockResolvedValue({ ...claim, envelope: messageEnvelope }),
      lockProcessingLease: vi.fn().mockResolvedValue(true),
      markProcessedInTransaction: vi.fn().mockResolvedValue(true), markFailed: vi.fn(),
    };
    const contacts = { enqueue: vi.fn().mockResolvedValue(true) };
    const processor = new WebhookProcessorService(
      database as unknown as DatabaseService,
      webhooks as unknown as WebhookRepository,
      { storeInTransaction: vi.fn() } as unknown as RuntimeEventRepository,
      {
        projectEventInTransaction: vi.fn().mockResolvedValue({ state: 'MISSING', statusAdvanced: false }),
      } as unknown as MessageStatusProjectionService,
      contacts as unknown as ContactMessageObserverService,
    );

    await processor.process(messageEnvelope.idempotencyKey);

    expect(contacts.enqueue).toHaveBeenCalledWith(client, {
      eventId: 'event-1',
      sessionId: 'session-1',
      senderId: 'sender@lid',
      pushName: ' Sender name ',
      observedAt: new Date('2026-08-11T00:00:00.000Z'),
    });
  });

  it('retries the webhook when its durable contact intent cannot be recorded', async () => {
    const database = databaseMock();
    const messageEnvelope: OpenWAWebhookEnvelope = {
      ...envelope,
      event: 'message.received',
      data: { id: 'inbound-1', author: 'sender@lid', contact: { pushName: 'Sender' } },
    };
    const webhooks = {
      claimForProcessing: vi.fn().mockResolvedValue({ ...claim, envelope: messageEnvelope }),
      lockProcessingLease: vi.fn().mockResolvedValue(true), markProcessedInTransaction: vi.fn(),
      markFailed: vi.fn().mockResolvedValue('RETRY'),
    };
    const processor = new WebhookProcessorService(
      database as unknown as DatabaseService,
      webhooks as unknown as WebhookRepository,
      { storeInTransaction: vi.fn().mockResolvedValue(true) } as unknown as RuntimeEventRepository,
      {} as MessageStatusProjectionService,
      { enqueue: vi.fn().mockRejectedValue(new Error('contacts unavailable')) } as unknown as ContactMessageObserverService,
    );

    await expect(processor.process(messageEnvelope.idempotencyKey)).rejects.toThrow('contacts unavailable');
    expect(webhooks.markProcessedInTransaction).not.toHaveBeenCalled();
    expect(webhooks.markFailed).toHaveBeenCalledOnce();
  });
});
