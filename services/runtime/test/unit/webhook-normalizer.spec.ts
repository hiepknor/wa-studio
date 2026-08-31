import { describe, expect, it } from 'vitest';
import { normalizeOpenWAWebhook } from '../../src/modules/webhooks/webhook-normalizer';

describe('normalizeOpenWAWebhook', () => {
  it('normalizes connector evidence without weakening its immutable identity', () => {
    const evidence = {
      protocolVersion: 1 as const,
      eventId: 'f698b26a-b23d-414d-be67-e09b127d6cc8',
      commandId: '760ba9a3-606c-4ceb-83ba-d6ea46e73fc1',
      attemptId: '9551a035-740f-4c01-b234-b1306de2fba8',
      sessionId: '91f27e51-fd00-4c07-bfbf-0ddf11a02af6',
      sequence: 2,
      kind: 'SEND_STARTED' as const,
      openwaMessageId: null,
      deliveryStatus: 'PENDING' as const,
      errorClass: null,
      errorCode: null,
      bindingGeneration: 4,
      pluginVersion: '1.0.0',
      occurredAt: '2026-08-31T10:00:00.000Z',
      payloadSha256: 'b'.repeat(64),
    };
    const event = normalizeOpenWAWebhook({
      event: 'wa-studio.connector.evidence',
      timestamp: '2026-08-31T10:00:01.000Z',
      sessionId: evidence.sessionId,
      idempotencyKey: `${evidence.eventId}_webhook-1`,
      deliveryId: evidence.eventId,
      data: evidence,
    });

    expect(event).toMatchObject({
      eventType: 'connector.delivery.evidence',
      sessionId: evidence.sessionId,
      occurredAt: new Date(evidence.occurredAt),
      payload: evidence,
    });
  });

  it('rejects connector evidence scoped to another session', () => {
    expect(() => normalizeOpenWAWebhook({
      event: 'wa-studio.connector.evidence',
      timestamp: '2026-08-31T10:00:01.000Z',
      sessionId: '91f27e51-fd00-4c07-bfbf-0ddf11a02af6',
      idempotencyKey: 'f698b26a-b23d-414d-be67-e09b127d6cc8_webhook-1',
      deliveryId: 'f698b26a-b23d-414d-be67-e09b127d6cc8',
      data: {
        protocolVersion: 1,
        eventId: 'f698b26a-b23d-414d-be67-e09b127d6cc8',
        commandId: '760ba9a3-606c-4ceb-83ba-d6ea46e73fc1',
        attemptId: '9551a035-740f-4c01-b234-b1306de2fba8',
        sessionId: '00000000-0000-4000-8000-000000000009',
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
      },
    })).toThrow('Invalid WA Studio connector evidence envelope');
  });

  it('normalizes an inbound group message without exposing the upstream payload', () => {
    const event = normalizeOpenWAWebhook({
      event: 'message.received',
      timestamp: '2026-08-11T05:00:00.000Z',
      sessionId: 'session-1',
      idempotencyKey: 'delivery-1:message.received',
      deliveryId: 'delivery-1',
      data: {
        id: 'message-1', chatId: '120363@g.us', from: '120363@g.us', author: '8497@c.us',
        body: 'hello', type: 'text', timestamp: 1786424400, fromMe: false, isGroup: true,
        contact: { pushName: 'must not leak' },
      },
    });

    expect(event).toMatchObject({
      eventId: 'delivery-1:message.received', eventType: 'message.received', eventVersion: 1,
      sessionId: 'session-1',
      payload: {
        messageId: 'message-1', groupId: '120363@g.us', senderId: '8497@c.us',
        body: 'hello', messageType: 'text', fromMe: false, isGroup: true,
      },
    });
    expect(event.payload).not.toHaveProperty('contact');
  });

  it('versions and renames a gateway session event', () => {
    const event = normalizeOpenWAWebhook({
      event: 'session.status', timestamp: '2026-08-11T05:00:00.000Z', sessionId: 'session-1',
      idempotencyKey: 'status-1', deliveryId: 'delivery-1', data: { status: 'ready' },
    });
    expect(event).toMatchObject({ eventType: 'session.status.changed', eventVersion: 1, payload: { status: 'ready' } });
  });

  it('normalizes account restrictions and lifts', () => {
    const restricted = normalizeOpenWAWebhook({
      event: 'session.restriction', timestamp: '2026-08-11T05:00:00.000Z', sessionId: 'session-1',
      idempotencyKey: 'restriction-1', deliveryId: 'delivery-1',
      data: { active: true, kind: 'reachout_timelock', code: 'BIZ_QUALITY', expiresAt: '2026-08-12T05:00:00.000Z' },
    });
    const lifted = normalizeOpenWAWebhook({
      event: 'session.restriction', timestamp: '2026-08-11T06:00:00.000Z', sessionId: 'session-1',
      idempotencyKey: 'restriction-2', deliveryId: 'delivery-2',
      data: { active: false, kind: 'reachout_timelock', code: 'BIZ_QUALITY', expiresAt: null },
    });

    expect(restricted).toMatchObject({
      eventType: 'session.restriction.changed',
      payload: { active: true, kind: 'reachout_timelock', code: 'BIZ_QUALITY' },
    });
    expect(lifted).toMatchObject({ eventType: 'session.restriction.changed', payload: { active: false } });
  });

  it('keeps only capability-relevant group event fields', () => {
    const event = normalizeOpenWAWebhook({
      event: 'group.update', timestamp: '2026-08-11T05:00:00.000Z', sessionId: 'session-1',
      idempotencyKey: 'group-1', deliveryId: 'delivery-1',
      data: { groupId: '120363@g.us', participantIds: [], changes: { announce: true }, ignored: 'raw' },
    });
    expect(event).toMatchObject({
      eventType: 'group.update',
      payload: { groupId: '120363@g.us', participantIds: [], changes: { announce: true } },
    });
    expect(event.payload).not.toHaveProperty('ignored');
  });
});
