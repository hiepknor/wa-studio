import { createServer, type IncomingMessage, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { createWebhookProxy, type WebhookProxyOptions } from '../../scripts/webhook-proxy';
import { signSha256Hmac } from '../../src/core/security/hmac-signature';

const servers: Server[] = [];
const webhookSecret = 'webhook-secret-with-at-least-32-characters';

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

    const body = '{"event":"test"}';
    const response = await fetch(`http://127.0.0.1:${portOf(proxy)}/api/v1/webhooks/openwa`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer must-not-forward',
        cookie: 'must-not-forward=true',
        'content-type': 'application/json',
        'proxy-authorization': 'Bearer must-not-forward',
        'x-forwarded-for': '203.0.113.1',
        'x-openwa-signature': signSha256Hmac(Buffer.from(body), webhookSecret),
      },
      body,
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(response.headers.get('x-runtime-result')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(received).toMatchObject({ body: '{"event":"test"}' });
    expect(received?.headers.host).toBe(`127.0.0.1:${portOf(upstream)}`);
    expect(received?.headers['x-openwa-signature']).toBe(signSha256Hmac(
      Buffer.from(body),
      webhookSecret,
    ));
    expect(received?.headers['proxy-authorization']).toBeUndefined();
    expect(received?.headers.authorization).toBeUndefined();
    expect(received?.headers.cookie).toBeUndefined();
    expect(received?.headers['x-forwarded-for']).toBeUndefined();

    const query = await fetch(
      `http://127.0.0.1:${portOf(proxy)}/api/v1/webhooks/openwa?unexpected=true`,
      { method: 'POST', body: '{}' },
    );
    expect(query.status).toBe(404);
  });

  it('rejects an invalid signature without contacting Event Inbox', async () => {
    let requests = 0;
    const upstream = await listen(createServer((_request, response) => {
      requests += 1;
      response.end('{}');
    }));
    const proxy = await listen(createWebhookProxy(options(portOf(upstream))));

    const response = await fetch(`http://127.0.0.1:${portOf(proxy)}/api/v1/webhooks/openwa`, {
      method: 'POST',
      headers: { 'x-openwa-signature': 'sha256=invalid' },
      body: '{}',
    });

    expect(response.status).toBe(401);
    expect(requests).toBe(0);
  });

  it('rejects oversized requests before contacting Event Inbox', async () => {
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
      headers: {
        'content-type': 'application/json',
        'x-openwa-signature': signSha256Hmac(
          Buffer.from(JSON.stringify({ padding: 'x'.repeat(1024) })),
          webhookSecret,
        ),
      },
      body: JSON.stringify({ padding: 'x'.repeat(1024) }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(requests).toBe(0);
  });

  it('bounds concurrent authenticated requests before buffering more work', async () => {
    let releaseUpstream: (() => void) | undefined;
    let markEntered: (() => void) | undefined;
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    const gate = new Promise<void>(resolve => { releaseUpstream = resolve; });
    const upstream = await listen(createServer(async (_request, response) => {
      markEntered?.();
      await gate;
      response.end('{"accepted":true}');
    }));
    const proxy = await listen(createWebhookProxy({
      ...options(portOf(upstream)),
      maximumConcurrentRequests: 1,
    }));
    const signedRequest = () => fetch(
      `http://127.0.0.1:${portOf(proxy)}/api/v1/webhooks/openwa`,
      {
        method: 'POST',
        headers: { 'x-openwa-signature': signSha256Hmac(Buffer.from('{}'), webhookSecret) },
        body: '{}',
      },
    );

    const first = signedRequest();
    await entered;
    const rejected = await signedRequest();
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get('retry-after')).toBe('1');
    releaseUpstream?.();
    expect((await first).status).toBe(200);
  });

  it('bounds upstream time and response memory with a generic 502', async () => {
    const stalled = await listen(createServer(() => undefined));
    const timeoutProxy = await listen(createWebhookProxy({
      ...options(portOf(stalled)),
      upstreamTimeoutMs: 50,
    }));
    const timedOut = await fetch(
      `http://127.0.0.1:${portOf(timeoutProxy)}/api/v1/webhooks/openwa`,
      {
        method: 'POST',
        headers: { 'x-openwa-signature': signSha256Hmac(Buffer.from('{}'), webhookSecret) },
        body: '{}',
      },
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
      {
        method: 'POST',
        headers: { 'x-openwa-signature': signSha256Hmac(Buffer.from('{}'), webhookSecret) },
        body: '{}',
      },
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });
});

function options(eventInboxPort: number): WebhookProxyOptions {
  return {
    eventInboxPort,
    webhookSecret,
    maximumRequestBytes: 1024 * 1024,
    maximumResponseBytes: 1024 * 1024,
    maximumConcurrentRequests: 8,
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
