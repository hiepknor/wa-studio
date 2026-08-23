import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { Pool } from 'pg';
import { migrateEventInboxDatabase } from '../src/core/event-inbox/event-inbox-migrations';
import { parseEventInboxConfig } from '../src/core/event-inbox/event-inbox-config';

const sessionId = '00000000-0000-4000-8000-000000000001';
const apiKey = 'event-inbox-e2e-openwa-key';
const masterSecret = 'event-inbox-e2e-master-secret-with-at-least-32-characters';

async function main(): Promise<void> {
  process.loadEnvFile();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for Event Inbox E2E');
  const database = new URL(process.env.DATABASE_URL);
  database.hostname = '127.0.0.1';
  database.port = '5433';
  const schema = `event_inbox_e2e_${process.pid}_${Date.now()}`;
  assert(/^[a-z0-9_]+$/u.test(schema), 'unsafe Event Inbox E2E schema');
  const admin = new Pool({ connectionString: database.toString(), max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  database.searchParams.set('options', `-csearch_path=${schema}`);

  const openwaPort = await availablePort();
  const eventInboxPort = await availablePort();
  const openwaBaseUrl = `http://127.0.0.1:${openwaPort}`;
  const eventInboxBaseUrl = `http://127.0.0.1:${eventInboxPort}`;
  const openwa = startOpenWAMock(openwaPort);
  await once(openwa, 'listening');
  const environment = {
    ...process.env,
    NODE_ENV: 'test',
    EVENT_INBOX_BIND_HOST: '127.0.0.1',
    EVENT_INBOX_PORT: String(eventInboxPort),
    EVENT_INBOX_DATABASE_URL: database.toString(),
    EVENT_INBOX_MASTER_SECRET: masterSecret,
    EVENT_INBOX_PUBLIC_BASE_URL: eventInboxBaseUrl,
    EVENT_INBOX_OPENWA_BASE_URL: openwaBaseUrl,
    EVENT_INBOX_ALLOWED_SESSION_IDS: sessionId,
    EVENT_INBOX_LEASE_SECONDS: '10',
  };
  const config = parseEventInboxConfig(environment);
  await migrateEventInboxDatabase(config);
  let inbox: ChildProcess | undefined;
  try {
    inbox = spawn(process.execPath, ['dist/src/entrypoints/event-inbox.js'], {
      env: environment,
      stdio: 'inherit',
    });
    await waitUntilReady(eventInboxBaseUrl);

    const pairing = await pair(eventInboxBaseUrl, openwaBaseUrl, randomUUID(), apiKey);
    assert(pairing.protocolVersion === 1, 'pairing protocol drifted');
    assert(pairing.sessionIds.join(',') === sessionId, 'pairing session scope drifted');
    assert(pairing.callbackUrl === `${eventInboxBaseUrl}/api/v1/webhooks/openwa`, 'callback drifted');
    const rejectedPairing = await fetch(`${eventInboxBaseUrl}/api/v1/event-inbox/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ openwaBaseUrl, openwaApiKey: 'wrong', deviceId: randomUUID() }),
    });
    assert(rejectedPairing.status === 401, 'invalid OpenWA credentials were accepted');

    const event = envelope('event-1');
    await postWebhook(pairing.callbackUrl, pairing.webhookSecret, event);
    const duplicate = await postWebhook(pairing.callbackUrl, pairing.webhookSecret, event);
    assert(duplicate.duplicate === true, 'duplicate webhook was not collapsed');

    const firstClaim = await claim(eventInboxBaseUrl, pairing.deviceToken);
    assert(firstClaim.data.length === 1, 'durable event was not claimed');
    const leasedClaim = await claim(eventInboxBaseUrl, pairing.deviceToken);
    assert(leasedClaim.data.length === 0, 'active lease allowed duplicate concurrent delivery');
    const firstReceipt = firstClaim.data[0]!.receiptHandle;
    const retry = await inboxRequest(eventInboxBaseUrl, pairing.deviceToken, 'events/nack', {
      items: [{ receiptHandle: firstReceipt, disposition: 'retry', reason: 'temporary_failure' }],
    });
    assert(retry.retried === 1, 'transient event was not released for retry');
    await new Promise(resolve => setTimeout(resolve, 1_100));
    const secondClaim = await claim(eventInboxBaseUrl, pairing.deviceToken);
    assert(secondClaim.data.length === 1, 'released event was not redelivered');
    const secondReceipt = secondClaim.data[0]!.receiptHandle;
    assert(firstReceipt !== secondReceipt, 'redelivery reused a stale receipt');
    const staleAck = await inboxRequest(eventInboxBaseUrl, pairing.deviceToken, 'events/ack', {
      receiptHandles: [firstReceipt],
    });
    assert(staleAck.acknowledged === 0, 'stale receipt deleted a re-leased event');
    const ack = await inboxRequest(eventInboxBaseUrl, pairing.deviceToken, 'events/ack', {
      receiptHandles: [secondReceipt],
    });
    assert(ack.acknowledged === 1, 'current receipt did not ACK the event');

    await postWebhook(pairing.callbackUrl, pairing.webhookSecret, envelope('poison-1'));
    const poison = await claim(eventInboxBaseUrl, pairing.deviceToken);
    const dead = await inboxRequest(eventInboxBaseUrl, pairing.deviceToken, 'events/nack', {
      items: [{
        receiptHandle: poison.data[0]!.receiptHandle,
        disposition: 'dead',
        reason: 'invalid_event_payload',
      }],
    });
    assert(dead.dead === 1, 'poison event was not isolated');
    const empty = await claim(eventInboxBaseUrl, pairing.deviceToken);
    assert(empty.data.length === 0, 'dead event continued starving the queue');
    const health = await publicRequest(`${eventInboxBaseUrl}/api/v1/health/ready`);
    assert(health.pendingEvents === 0 && health.deadEvents === 1, 'health did not expose poison isolation');

    process.stdout.write(
      'Event Inbox E2E passed: OpenWA pairing, HMAC, dedup, lease fencing, retry, ACK and poison isolation.\n',
    );
  } finally {
    if (inbox) await stop(inbox);
    openwa.close();
    await once(openwa, 'close');
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}

function startOpenWAMock(port: number): Server {
  return createServer((request, response) => {
    if (request.headers['x-api-key'] !== apiKey) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'unauthorized' }));
      return;
    }
    if (request.url === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        status: 'ok', timestamp: new Date().toISOString(), version: '0.22.0',
      }));
      return;
    }
    if (request.url === '/api/sessions?limit=1000') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify([{ id: sessionId }]));
      return;
    }
    response.writeHead(404).end();
  }).listen(port, '127.0.0.1');
}

async function pair(baseUrl: string, openwaBaseUrl: string, deviceId: string, openwaApiKey: string) {
  const response = await fetch(`${baseUrl}/api/v1/event-inbox/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ openwaBaseUrl, openwaApiKey, deviceId }),
  });
  if (!response.ok) throw new Error(`Event Inbox pairing returned HTTP ${response.status}`);
  return response.json() as Promise<any>;
}

function envelope(idempotencyKey: string) {
  return {
    event: 'message.received',
    timestamp: new Date().toISOString(),
    sessionId,
    idempotencyKey,
    deliveryId: `delivery-${idempotencyKey}`,
    data: { id: `message-${idempotencyKey}` },
  };
}

async function postWebhook(callbackUrl: string, secret: string, event: unknown) {
  const rawBody = JSON.stringify(event);
  const signature = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const response = await fetch(callbackUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openwa-signature': signature },
    body: rawBody,
  });
  if (!response.ok) throw new Error(`Event Inbox webhook returned HTTP ${response.status}`);
  return response.json() as Promise<any>;
}

function claim(baseUrl: string, token: string) {
  return inboxRequest(baseUrl, token, 'events/claim', { limit: 100, waitSeconds: 0 });
}

async function inboxRequest(baseUrl: string, token: string, path: string, body: unknown) {
  const response = await fetch(`${baseUrl}/api/v1/event-inbox/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Event Inbox request returned HTTP ${response.status}`);
  return response.json() as Promise<any>;
}

async function publicRequest(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Public request returned HTTP ${response.status}`);
  return response.json() as Promise<any>;
}

async function availablePort(): Promise<number> {
  const server = createTcpServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a port');
  server.close();
  await once(server, 'close');
  return address.port;
}

async function waitUntilReady(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/health/ready`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Event Inbox did not become ready');
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
