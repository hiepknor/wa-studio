import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRuntimeConfig } from '../../src/core/config/runtime-config';
import { EventInboxConnectorClient } from '../../src/modules/webhooks/event-inbox-connector.client';

const sessionId = '00000000-0000-4000-8000-000000000001';
const connectorId = '00000000-0000-4000-8000-000000000002';

function client(): EventInboxConnectorClient {
  return new EventInboxConnectorClient(parseRuntimeConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://runtime:runtime@postgres.test:5432/runtime',
    REDIS_URL: 'redis://redis.test:6379',
    RUNTIME_API_KEY: 'runtime-key-with-at-least-32-characters',
    OPENWA_BASE_URL: 'http://openwa.test:2785',
    OPENWA_API_KEY: 'openwa-key',
    OPENWA_WEBHOOK_SECRET: 'webhook-secret-with-at-least-32-characters',
    OPENWA_ALLOWED_SESSION_IDS: sessionId,
    EVENT_INBOX_BASE_URL: 'http://127.0.0.1:34200',
    EVENT_INBOX_DEVICE_TOKEN: 'device-token-with-at-least-32-characters',
  }));
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('EventInboxConnectorClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts only a complete binding acknowledgement', async () => {
    const acknowledgement = {
      sessionId,
      connectorId,
      webhookId: 'webhook-1',
      generation: 2,
      updatedAt: '2026-09-04T00:00:00.000Z',
    };
    const fetchMock = vi.fn().mockResolvedValue(response(acknowledgement));
    vi.stubGlobal('fetch', fetchMock);

    await expect(client().setBinding({
      sessionId, connectorId, webhookId: 'webhook-1', generation: 2,
    })).resolves.toEqual(acknowledgement);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(`http://127.0.0.1:34200/api/v1/event-inbox/connectors/bindings/${sessionId}`),
      expect.objectContaining({ method: 'PUT', redirect: 'error' }),
    );

    fetchMock.mockResolvedValueOnce(response({
      connectorId, webhookId: 'webhook-1', generation: 2,
    }));
    await expect(client().setBinding({
      sessionId, connectorId, webhookId: 'webhook-1', generation: 2,
    })).rejects.toThrow('invalid connector binding');
  });

  it('rejects ambiguous duplicate session reports', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      protocolVersion: 1,
      generatedAt: '2026-09-04T00:00:00.000Z',
      sessions: [
        { sessionId, binding: null, connector: null },
        { sessionId, binding: null, connector: null },
      ],
    })));

    await expect(client().status()).rejects.toThrow('invalid connector status');
  });
});
