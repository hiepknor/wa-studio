import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { parseEventInboxConfig, type EventInboxConfig } from '../../src/core/event-inbox/event-inbox-config';
import { EventInboxTokenService } from '../../src/core/event-inbox/event-inbox-token.service';
import type { EventInboxOpenWAClient } from '../../src/integrations/openwa/event-inbox-openwa.client';
import {
  EventInboxController,
  EventInboxIngressController,
} from '../../src/modules/event-inbox/event-inbox.controller';
import { encodeEventInboxReceipt } from '../../src/modules/event-inbox/event-inbox-receipt';
import type { EventInboxRepository } from '../../src/modules/event-inbox/event-inbox.repository';

const sessionId = '00000000-0000-4000-8000-000000000001';
const deviceId = '00000000-0000-4000-8000-000000000002';
const masterSecret = 'event-inbox-master-secret-with-at-least-32-characters';

function config(): EventInboxConfig {
  return parseEventInboxConfig({
    NODE_ENV: 'test',
    EVENT_INBOX_DATABASE_URL: 'postgresql://events:events@postgres.test:5432/events',
    EVENT_INBOX_MASTER_SECRET: masterSecret,
    EVENT_INBOX_PUBLIC_BASE_URL: 'http://127.0.0.1:34200',
    EVENT_INBOX_OPENWA_BASE_URL: 'http://127.0.0.1:2785',
    EVENT_INBOX_ALLOWED_SESSION_IDS: sessionId,
  });
}

describe('Event Inbox boundary', () => {
  it('validates PostgreSQL and bounded durable-delivery defaults', () => {
    expect(config()).toMatchObject({
      EVENT_INBOX_BIND_HOST: '127.0.0.1',
      EVENT_INBOX_MAX_STORED_EVENTS: 100_000,
      EVENT_INBOX_MAX_PAYLOAD_BYTES: 262_144,
      EVENT_INBOX_LEASE_SECONDS: 60,
      EVENT_INBOX_RETENTION_DAYS: 7,
    });
    expect(() => parseEventInboxConfig({
      ...configEnvironment(),
      EVENT_INBOX_DATABASE_URL: 'redis://redis.test:6379',
    })).toThrow('must use PostgreSQL');
  });

  it('accepts only signed allowlisted OpenWA envelopes', async () => {
    const repository = { insert: vi.fn().mockResolvedValue('created') };
    const tokens = new EventInboxTokenService(config());
    const controller = new EventInboxIngressController(
      repository as unknown as EventInboxRepository,
      tokens,
      config(),
    );
    const envelope = {
      event: 'message.received', timestamp: '2026-08-22T00:00:00Z', sessionId,
      idempotencyKey: 'event-1', deliveryId: 'delivery-1', data: { id: 'message-1' },
    };
    const rawBody = Buffer.from(JSON.stringify(envelope));
    const signature = `sha256=${createHmac('sha256', tokens.webhookSecret()).update(rawBody).digest('hex')}`;

    await expect(controller.receive({ rawBody, body: envelope } as never, signature))
      .resolves.toEqual({ accepted: true, duplicate: false });
    await expect(controller.receive({ rawBody, body: envelope } as never, 'sha256=invalid'))
      .rejects.toThrow('Invalid OpenWA webhook signature');
  });

  it('pairs from verified OpenWA credentials and scopes claim/ACK/NACK to a device token', async () => {
    const receiptHandle = encodeEventInboxReceipt({ idempotencyKey: 'event-1', leaseId: crypto.randomUUID() });
    const repository = {
      claim: vi.fn().mockResolvedValue([{ idempotencyKey: 'event-1', receiptHandle }]),
      acknowledge: vi.fn().mockResolvedValue(1),
      negativelyAcknowledge: vi.fn().mockResolvedValue({ retried: 0, dead: 1 }),
    };
    const openwa = { validateCredentials: vi.fn().mockResolvedValue([sessionId]) };
    const tokens = new EventInboxTokenService(config());
    const controller = new EventInboxController(
      repository as unknown as EventInboxRepository,
      tokens,
      openwa as unknown as EventInboxOpenWAClient,
      config(),
    );
    const pairing = await controller.pair({
      openwaBaseUrl: 'http://127.0.0.1:2785', openwaApiKey: 'openwa-key', deviceId,
    });

    expect(pairing).toMatchObject({
      protocolVersion: 1,
      eventInboxBaseUrl: 'http://127.0.0.1:34200',
      callbackUrl: 'http://127.0.0.1:34200/api/v1/webhooks/openwa',
      sessionIds: [sessionId],
    });
    const authorization = `Bearer ${pairing.deviceToken}`;
    await expect(controller.claim(authorization, { limit: 10, waitSeconds: 0 }))
      .resolves.toEqual({ data: [{ idempotencyKey: 'event-1', receiptHandle }] });
    await expect(controller.acknowledge(authorization, { receiptHandles: [receiptHandle] }))
      .resolves.toEqual({ acknowledged: 1 });
    await expect(controller.negativelyAcknowledge(authorization, { items: [{
      receiptHandle, disposition: 'dead', reason: 'invalid_event_payload',
    }] })).resolves.toEqual({ retried: 0, dead: 1 });
    await expect(controller.claim('Bearer invalid', { limit: 10, waitSeconds: 0 }))
      .rejects.toThrow('Invalid Event Inbox device token');
  });
});

function configEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    EVENT_INBOX_DATABASE_URL: 'postgresql://events:events@postgres.test:5432/events',
    EVENT_INBOX_MASTER_SECRET: masterSecret,
    EVENT_INBOX_PUBLIC_BASE_URL: 'http://127.0.0.1:34200',
    EVENT_INBOX_OPENWA_BASE_URL: 'http://127.0.0.1:2785',
    EVENT_INBOX_ALLOWED_SESSION_IDS: sessionId,
  };
}
