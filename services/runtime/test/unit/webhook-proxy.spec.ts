import { createServer, type IncomingMessage, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { createWebhookProxy, type WebhookProxyOptions } from '../../scripts/webhook-proxy';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe('webhook-only proxy', () => {
  it('forwards only the exact route and strips credential-bearing hop headers', async () => {
    let received: { body: string; headers: IncomingMessage['headers'] } | undefined;
    const upstream = await listen(createServer(async (request, response) => {
      received = { body: (await readBody(request)).toString('utf8'), headers: request.headers };
      response.writeHead(202, { 'content-type': 'application/json', 'x-runtime-result': 'accepted' });
      response.end('{"accepted":true}');
    }));
    const proxy = await listen(createWebhookProxy(options(portOf(upstream))));

    const response = await fetch(`http://127.0.0.1:${portOf(proxy)}/api/v1/webhooks/openwa`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'proxy-authorization': 'Bearer must-not-forward',
        'x-openwa-signature': 'sha256=test',
      },
      body: '{"event":"test"}',
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(response.headers.get('x-runtime-result')).toBe('accepted');
    expect(received).toMatchObject({ body: '{"event":"test"}' });
    expect(received?.headers.host).toBe(`127.0.0.1:${portOf(upstream)}`);
    expect(received?.headers['x-openwa-signature']).toBe('sha256=test');
    expect(received?.headers['proxy-authorization']).toBeUndefined();

    const query = await fetch(
      `http://127.0.0.1:${portOf(proxy)}/api/v1/webhooks/openwa?unexpected=true`,
      { method: 'POST', body: '{}' },
    );
    expect(query.status).toBe(404);
  });

  it('rejects oversized requests before contacting Runtime', async () => {
    let requests = 0;
    const upstream = await listen(createServer((_request, response) => {
      requests += 1;
      response.end('{}');
    }));
    const proxy = await listen(createWebhookProxy({
      ...options(portOf(upstream)),
      maximumRequestBytes: 1024,
    }));

    const response = await fetch(`http://127.0.0.1:${portOf(proxy)}/api/v1/webhooks/openwa`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(1024) }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(requests).toBe(0);
  });

  it('bounds upstream time and response memory with a generic 502', async () => {
    const stalled = await listen(createServer(() => undefined));
    const timeoutProxy = await listen(createWebhookProxy({
      ...options(portOf(stalled)),
      upstreamTimeoutMs: 50,
    }));
    const timedOut = await fetch(
      `http://127.0.0.1:${portOf(timeoutProxy)}/api/v1/webhooks/openwa`,
      { method: 'POST', body: '{}' },
    );
    expect(timedOut.status).toBe(502);
    await expect(timedOut.json()).resolves.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });

    const oversized = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'content-length': '2048' });
      response.end('x'.repeat(2048));
    }));
    const responseProxy = await listen(createWebhookProxy({
      ...options(portOf(oversized)),
      maximumResponseBytes: 1024,
    }));
    const response = await fetch(
      `http://127.0.0.1:${portOf(responseProxy)}/api/v1/webhooks/openwa`,
      { method: 'POST', body: '{}' },
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });
});

function options(runtimePort: number): WebhookProxyOptions {
  return {
    runtimePort,
    maximumRequestBytes: 1024 * 1024,
    maximumResponseBytes: 1024 * 1024,
    upstreamTimeoutMs: 1_000,
    requestTimeoutMs: 2_000,
    headersTimeoutMs: 1_000,
  };
}

async function listen(server: Server): Promise<Server> {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

function portOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server has no TCP address');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}
