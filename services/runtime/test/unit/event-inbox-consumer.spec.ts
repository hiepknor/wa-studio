import { BadRequestException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRuntimeConfig } from '../../src/core/config/runtime-config';
import { OutboundResponseTooLargeError } from '../../src/core/http/bounded-response';
import { EventInboxConsumerService } from '../../src/modules/webhooks/event-inbox-consumer.service';
import type { RuntimeDispatchReadinessService } from '../../src/core/dispatch-readiness/runtime-dispatch-readiness.service';
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
  it('drains every event through the captured recovery watermark before opening dispatch', async () => {
    const ingress = { accept: vi.fn().mockResolvedValue({ accepted: true, duplicate: false }) };
    const readiness = {
      markReady: vi.fn().mockResolvedValue(undefined),
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ watermark: '12', remaining: 1 }))
      .mockResolvedValueOnce(jsonResponse({ data: [claimedEvent] }))
      .mockResolvedValueOnce(jsonResponse({ acknowledged: 1 }))
      .mockResolvedValueOnce(jsonResponse({ watermark: '12', remaining: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new EventInboxConsumerService(
      ingress as unknown as WebhookIngressService,
      config(),
      readiness as unknown as RuntimeDispatchReadinessService,
    ).recover()).resolves.toBe('12');

    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({
      limit: config().EVENT_INBOX_BATCH_SIZE,
      waitSeconds: 0,
      throughSequence: '12',
    });
    expect(readiness.markReady).toHaveBeenCalledWith('12');
    expect(readiness.markReady.mock.invocationCallOrder[0])
      .toBeGreaterThan(fetchMock.mock.invocationCallOrder[3]!);
  });

  it('rejects a claim response larger than the configured memory boundary', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', {
      headers: { 'content-length': String(config().EVENT_INBOX_RESPONSE_MAX_BYTES + 1) },
    })));

    await expect(new EventInboxConsumerService(
      { accept: vi.fn() } as unknown as WebhookIngressService, config(),
    ).runOnce()).rejects.toBeInstanceOf(OutboundResponseTooLargeError);
  });

  it('accepts the protocol maximum 1 MiB raw event representation', async () => {
    const maximumEnvelope = {
      event: 'message.received', timestamp: '2026-08-22T00:00:00Z', sessionId,
      idempotencyKey: 'event-1', deliveryId: 'delivery-1', data: { padding: '' },
    };
    const envelopeOverhead = Buffer.byteLength(JSON.stringify(maximumEnvelope), 'utf8');
    maximumEnvelope.data.padding = 'x'.repeat(1_048_576 - envelopeOverhead);
    const maximumRawBody = Buffer.from(JSON.stringify(maximumEnvelope), 'utf8');
    expect(maximumRawBody).toHaveLength(1_048_576);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{
        ...claimedEvent,
        rawBody: maximumRawBody.toString('base64'),
      }] }))
      .mockResolvedValueOnce(jsonResponse({ acknowledged: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const ingress = { accept: vi.fn().mockResolvedValue({ accepted: true, duplicate: false }) };

    await expect(new EventInboxConsumerService(
      ingress as unknown as WebhookIngressService,
      parseRuntimeConfig({
        ...configEnvironment(),
        EVENT_INBOX_RESPONSE_MAX_BYTES: '41943040',
      }),
    ).runOnce()).resolves.toBe(1);
    expect(ingress.accept).toHaveBeenCalledWith(maximumRawBody, claimedEvent.signature, expect.anything());
  }, 15_000);

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

function configEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test', RUNTIME_PROFILE: 'desktop-managed', QUEUE_BACKEND: 'postgres',
    DATABASE_URL: 'postgresql://runtime:runtime@postgres.test/runtime',
    RUNTIME_API_KEY: 'runtime-key-with-at-least-32-characters',
    OPENWA_BASE_URL: 'http://openwa.test:2785', OPENWA_API_KEY: 'openwa-key',
    OPENWA_WEBHOOK_SECRET: 'webhook-secret-with-at-least-32-characters',
    OPENWA_ALLOWED_SESSION_IDS: sessionId,
    EVENT_INBOX_BASE_URL: 'http://127.0.0.1:34200',
    EVENT_INBOX_DEVICE_TOKEN: 'device-token-with-at-least-32-characters',
  };
}
