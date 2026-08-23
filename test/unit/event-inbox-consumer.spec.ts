import { BadRequestException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRuntimeConfig } from '../../src/core/config/runtime-config';
import { EventInboxConsumerService } from '../../src/modules/webhooks/event-inbox-consumer.service';
import type { WebhookIngressService } from '../../src/modules/webhooks/webhook-ingress.service';

const sessionId = '00000000-0000-4000-8000-000000000001';
const rawBody = Buffer.from(JSON.stringify({
  event: 'message.received', timestamp: '2026-08-22T00:00:00Z', sessionId,
  idempotencyKey: 'event-1', deliveryId: 'delivery-1', data: { id: 'message-1' },
}));

function config() {
  return parseRuntimeConfig({
    NODE_ENV: 'test', RUNTIME_PROFILE: 'desktop-managed', QUEUE_BACKEND: 'postgres',
    DATABASE_URL: 'postgresql://runtime:runtime@postgres.test/runtime',
    RUNTIME_API_KEY: 'runtime-key-with-at-least-32-characters',
    OPENWA_BASE_URL: 'http://openwa.test:2785', OPENWA_API_KEY: 'openwa-key',
    OPENWA_WEBHOOK_SECRET: 'webhook-secret-with-at-least-32-characters',
    OPENWA_ALLOWED_SESSION_IDS: sessionId,
    EVENT_INBOX_BASE_URL: 'http://127.0.0.1:34200',
    EVENT_INBOX_DEVICE_TOKEN: 'device-token-with-at-least-32-characters',
  });
}

const claimedEvent = {
  idempotencyKey: 'event-1', receiptHandle: 'receipt-1',
  rawBody: rawBody.toString('base64'), signature: 'sha256=original',
};

afterEach(() => vi.unstubAllGlobals());

describe('EventInboxConsumerService', () => {
  it('ACKs only after durable local ingress accepts an event', async () => {
    const ingress = { accept: vi.fn().mockResolvedValue({ accepted: true, duplicate: false }) };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [claimedEvent] }))
      .mockResolvedValueOnce(jsonResponse({ acknowledged: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new EventInboxConsumerService(
      ingress as unknown as WebhookIngressService, config(),
    ).runOnce()).resolves.toBe(1);
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string))
      .toEqual({ receiptHandles: ['receipt-1'] });
  });

  it('NACKs deterministic poison events to dead instead of starving the queue', async () => {
    const ingress = { accept: vi.fn().mockRejectedValue(new BadRequestException('bad envelope')) };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [claimedEvent] }))
      .mockResolvedValueOnce(jsonResponse({ retried: 0, dead: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new EventInboxConsumerService(
      ingress as unknown as WebhookIngressService, config(),
    ).runOnce()).resolves.toBe(1);
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({ items: [{
      receiptHandle: 'receipt-1', disposition: 'dead', reason: 'invalid_openwa_envelope',
    }] });
  });

  it('releases transient local failures for bounded retry', async () => {
    const ingress = { accept: vi.fn().mockRejectedValue(new Error('database unavailable')) };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [claimedEvent] }))
      .mockResolvedValueOnce(jsonResponse({ retried: 1, dead: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    await new EventInboxConsumerService(
      ingress as unknown as WebhookIngressService, config(),
    ).runOnce();
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({ items: [{
      receiptHandle: 'receipt-1', disposition: 'retry', reason: 'runtime_ingress_unavailable',
    }] });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}
