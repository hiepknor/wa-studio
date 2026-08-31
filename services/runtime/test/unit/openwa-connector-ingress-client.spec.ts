import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRuntimeConfig } from '../../src/core/config/runtime-config';
import {
  OpenWAConnectorIngressClient,
  OpenWAConnectorIngressError,
} from '../../src/integrations/openwa/openwa-connector-ingress.client';

const ingressSecret = 'connector-ingress-secret-with-at-least-32-characters';

function client() {
  return new OpenWAConnectorIngressClient(parseRuntimeConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://runtime:runtime@postgres.test:5432/runtime',
    REDIS_URL: 'redis://redis.test:6379',
    RUNTIME_API_KEY: 'runtime-key-with-at-least-32-characters',
    OPENWA_BASE_URL: 'http://openwa.test:2785',
    OPENWA_API_KEY: 'openwa-key',
    OPENWA_WEBHOOK_SECRET: 'webhook-secret-with-at-least-32-characters',
    OPENWA_ALLOWED_SESSION_IDS: '00000000-0000-4000-8000-000000000001',
    OPENWA_CONNECTOR_INSTANCE_ID: 'instance-1',
    OPENWA_CONNECTOR_INGRESS_SECRET: ingressSecret,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('OpenWAConnectorIngressClient', () => {
  it('signs the exact command bytes and uses the stable command id as delivery identity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T12:00:00.000Z'));
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const body = Buffer.from('{"stable":true}', 'utf8');
    const commandId = '00000000-0000-4000-8000-000000000002';

    await expect(client().submit({ commandId, body })).resolves.toEqual({ duplicate: false });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      'http://openwa.test:2785/api/ingress/wa-studio-connector/instance-1/commands',
    );
    const headers = init.headers as Record<string, string>;
    expect(init.body).toBe(body);
    expect(headers['x-delivery']).toBe(commandId);
    expect(headers['x-wa-timestamp']).toBe('1788177600');
    expect(headers['x-wa-signature']).toBe(`sha256=${createHmac('sha256', ingressSecret)
      .update('1788177600.')
      .update(body)
      .digest('hex')}`);
  });

  it('distinguishes duplicate acknowledgement, safe throttling and ambiguous failures', async () => {
    const body = Buffer.from('{}');
    const commandId = '00000000-0000-4000-8000-000000000002';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response('slow down', {
        status: 429,
        headers: { 'retry-after': '3' },
      }))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('invalid', { status: 400 }))
      .mockRejectedValueOnce(new Error('connection reset'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(client().submit({ commandId, body })).resolves.toEqual({ duplicate: true });
    await expect(client().submit({ commandId, body })).rejects.toMatchObject({
      kind: 'RATE_LIMITED_SAFE', status: 429, retryAfterMs: 3_000,
    } satisfies Partial<OpenWAConnectorIngressError>);
    await expect(client().submit({ commandId, body })).rejects.toMatchObject({
      kind: 'AMBIGUOUS_RETRYABLE', status: 503,
    } satisfies Partial<OpenWAConnectorIngressError>);
    await expect(client().submit({ commandId, body })).rejects.toMatchObject({
      kind: 'DEFINITIVE', status: 400,
    } satisfies Partial<OpenWAConnectorIngressError>);
    await expect(client().submit({ commandId, body })).rejects.toMatchObject({
      kind: 'AMBIGUOUS_RETRYABLE', status: null,
    } satisfies Partial<OpenWAConnectorIngressError>);
  });
});
