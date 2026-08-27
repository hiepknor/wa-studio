import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Pool } from 'pg';
import { migrateEventInboxDatabase } from '../src/core/event-inbox/event-inbox-migrations';
import { parseEventInboxConfig } from '../src/core/event-inbox/event-inbox-config';
import { OPENWA_RELEASE_TAG } from '../src/contracts/release/openwa-release.generated';

const sessionId = '00000000-0000-4000-8000-000000000001';
const apiKey = 'event-inbox-e2e-openwa-key';
const masterSecret = 'event-inbox-e2e-master-secret-with-at-least-32-characters';
const metricsToken = 'event-inbox-e2e-metrics-token-with-at-least-32-characters';

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for Event Inbox E2E');
  const database = new URL(process.env.DATABASE_URL);
  database.hostname = '127.0.0.1';
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
    EVENT_INBOX_METRICS_TOKEN: metricsToken,
    EVENT_INBOX_PUBLIC_BASE_URL: eventInboxBaseUrl,
    EVENT_INBOX_OPENWA_BASE_URL: openwaBaseUrl,
    EVENT_INBOX_ALLOWED_SESSION_IDS: sessionId,
    EVENT_INBOX_LEASE_SECONDS: '10',
    EVENT_INBOX_V1_ACCEPT_UNTIL: new Date(Date.now() + 3_600_000).toISOString(),
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

    const liveResponse = await fetch(`${eventInboxBaseUrl}/api/v1/health/live`);
    assert(liveResponse.headers.get('x-content-type-options') === 'nosniff', 'security headers are missing');
    assert(liveResponse.headers.get('x-powered-by') === null, 'Express fingerprint header is exposed');

    const unauthorizedMetrics = await fetch(`${eventInboxBaseUrl}/api/v1/metrics`);
    assert(unauthorizedMetrics.status === 401, 'Event Inbox metrics accepted an unauthenticated scrape');
    const metricsResponse = await fetch(`${eventInboxBaseUrl}/api/v1/metrics`, {
      headers: { authorization: `Bearer ${metricsToken}` },
    });
    const metrics = await metricsResponse.text();
    assert(metricsResponse.status === 200, 'Event Inbox metrics rejected its dedicated token');
    assert(metrics.includes('wa_event_inbox_metrics_snapshot_up 1'), 'Event Inbox snapshot metric is missing');
    assert(metrics.includes('wa_event_inbox_storage_limit_bytes'), 'Event Inbox capacity metric is missing');
    assert(!metrics.includes(metricsToken), 'Event Inbox metrics exposed its credential');

    const legacyToken = issueLegacyDeviceToken(masterSecret, randomUUID(), [sessionId]);
    await claim(eventInboxBaseUrl, legacyToken);

    const deviceId = randomUUID();
    const firstPairing = await pair(eventInboxBaseUrl, openwaBaseUrl, deviceId, apiKey);
    assert(firstPairing.protocolVersion === 2, 'pairing protocol drifted');
    await expectUnauthorized(eventInboxBaseUrl, legacyToken);
    await postWebhook(
      firstPairing.callbackUrl,
      firstPairing.webhookSecret,
      envelope('rotation-fence'),
    );
    const preRotationClaim = await claim(eventInboxBaseUrl, firstPairing.deviceToken);
    assert(preRotationClaim.data.length === 1, 'pre-rotation device did not acquire a lease');
    const pairing = await pair(eventInboxBaseUrl, openwaBaseUrl, deviceId, apiKey);
    await expectUnauthorized(eventInboxBaseUrl, firstPairing.deviceToken);
    const postRotationClaim = await claim(eventInboxBaseUrl, pairing.deviceToken);
    assert(postRotationClaim.data.length === 1, 'rotation did not release the stale device lease');
    assert(
      postRotationClaim.data[0]!.receiptHandle !== preRotationClaim.data[0]!.receiptHandle,
      'rotation reused a stale receipt fence',
    );
    const rotationAck = await inboxRequest(eventInboxBaseUrl, pairing.deviceToken, 'events/ack', {
      receiptHandles: [postRotationClaim.data[0]!.receiptHandle],
    });
    assert(rotationAck.acknowledged === 1, 'rotated device could not ACK its fenced lease');
    assert(pairing.sessionIds.join(',') === sessionId, 'pairing session scope drifted');
    assert(pairing.callbackUrl === `${eventInboxBaseUrl}/api/v1/webhooks/openwa`, 'callback drifted');

    const largeEnvelope = {
      ...envelope('parser-over-100-kib'),
      data: { padding: 'x'.repeat(130_000) },
    };
    await postWebhook(pairing.callbackUrl, pairing.webhookSecret, largeEnvelope);
    const largeClaim = await claim(eventInboxBaseUrl, pairing.deviceToken);
    assert(largeClaim.data.length === 1, 'custom parser rejected a valid webhook above Nest default size');
    const largeAck = await inboxRequest(eventInboxBaseUrl, pairing.deviceToken, 'events/ack', {
      receiptHandles: [largeClaim.data[0]!.receiptHandle],
    });
    assert(largeAck.acknowledged === 1, 'large webhook could not complete delivery');

    const oversizedWebhook = await fetch(pairing.callbackUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openwa-signature': 'sha256=irrelevant' },
      body: JSON.stringify({ padding: 'x'.repeat(262_144) }),
    });
    assert(oversizedWebhook.status === 413, 'Event Inbox accepted a webhook above its configured body cap');
    const oversizedBody = await oversizedWebhook.json() as { code?: string };
    assert(oversizedBody.code === 'PAYLOAD_TOO_LARGE', 'Event Inbox did not normalize its 413 response');
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
    assert(
      health.activeDevices === 1 && health.legacyDevices === 1 && health.ownedSessions === 1,
      'health did not expose the v1-to-v2 ownership cutover state',
    );

    const replacement = await pair(eventInboxBaseUrl, openwaBaseUrl, randomUUID(), apiKey);
    await expectUnauthorized(eventInboxBaseUrl, pairing.deviceToken);
    await claim(eventInboxBaseUrl, replacement.deviceToken);
    const revoked = await inboxRequest(
      eventInboxBaseUrl,
      replacement.deviceToken,
      'devices/revoke',
      {},
    );
    assert(revoked.revoked === true, 'active Event Inbox device was not revoked');
    await expectUnauthorized(eventInboxBaseUrl, replacement.deviceToken);

    const finalAllowedPairing = await fetch(`${eventInboxBaseUrl}/api/v1/event-inbox/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ openwaBaseUrl, openwaApiKey: 'wrong', deviceId: randomUUID() }),
    });
    assert(finalAllowedPairing.status === 401, 'pairing limiter rejected an in-budget request');
    const rateLimitedPairing = await fetch(`${eventInboxBaseUrl}/api/v1/event-inbox/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ openwaBaseUrl, openwaApiKey: 'wrong', deviceId: randomUUID() }),
    });
    assert(rateLimitedPairing.status === 429, 'pairing limiter allowed an over-budget request');
    assert(Number(rateLimitedPairing.headers.get('retry-after')) > 0, 'pairing limiter omitted Retry-After');
    const limitedHealth = await publicRequest(`${eventInboxBaseUrl}/api/v1/health/ready`);
    assert(
      limitedHealth.activeRateLimitBuckets === 2
        && limitedHealth.rateLimitedPairingAttempts === 1,
      'health did not expose active pairing rate-limit state',
    );

    process.stdout.write(
      'Event Inbox E2E passed: bounded HTTP parsing, security headers, v1 adoption, v2 rotation/takeover/revocation, HMAC, dedup, lease fencing, retry, ACK, poison isolation, durable pairing rate limits and private metrics.\n',
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
        status: 'ok', timestamp: new Date().toISOString(), version: OPENWA_RELEASE_TAG,
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

function issueLegacyDeviceToken(secret: string, deviceId: string, sessionIds: string[]): string {
  const payload = Buffer.from(JSON.stringify({ version: 1, deviceId, sessionIds }), 'utf8')
    .toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(`device-token:v1:${payload}`)
    .digest('base64url');
  return `${payload}.${signature}`;
}

async function expectUnauthorized(baseUrl: string, token: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/v1/event-inbox/events/claim`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ limit: 1, waitSeconds: 0 }),
  });
  assert(response.status === 401, `revoked Event Inbox token returned HTTP ${response.status}`);
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
