import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { OPENWA_RELEASE_TAG } from '../../src/contracts/release/openwa-release.generated';
import { parseEventInboxConfig, type EventInboxConfig } from '../../src/core/event-inbox/event-inbox-config';
import { EventInboxTokenService } from '../../src/core/event-inbox/event-inbox-token.service';
import type { EventInboxOpenWAClient } from '../../src/integrations/openwa/event-inbox-openwa.client';
import {
  EventInboxController,
  EventInboxHealthController,
  EventInboxIngressController,
} from '../../src/modules/event-inbox/event-inbox.controller';
import type { EventInboxDeviceRepository } from '../../src/modules/event-inbox/event-inbox-device.repository';
import { encodeEventInboxReceipt } from '../../src/modules/event-inbox/event-inbox-receipt';
import { EventInboxPairRateLimitService } from '../../src/modules/event-inbox/event-inbox-rate-limit.service';
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
      EVENT_INBOX_MAX_STORED_EVENTS: 500_000,
      EVENT_INBOX_MAX_STORED_BYTES: 2_147_483_648,
      EVENT_INBOX_MAX_PAYLOAD_BYTES: 262_144,
      EVENT_INBOX_MEDIA_MAX_BYTES: 8_388_608,
      EVENT_INBOX_MEDIA_MAX_STORED_BYTES: 536_870_912,
      EVENT_INBOX_MEDIA_MAX_LEASE_SECONDS: 7_200,
      EVENT_INBOX_MEDIA_MAX_DOWNLOADS_PER_LEASE: 20,
      EVENT_INBOX_LEASE_SECONDS: 60,
      EVENT_INBOX_RETENTION_DAYS: 7,
      EVENT_INBOX_RECEIPT_RETENTION_DAYS: 35,
      EVENT_INBOX_DEVICE_TOKEN_TTL_DAYS: 365,
      EVENT_INBOX_PAIR_RATE_LIMIT_MAX_ATTEMPTS: 5,
      EVENT_INBOX_PAIR_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS: 100,
      EVENT_INBOX_PAIR_RATE_LIMIT_WINDOW_SECONDS: 300,
      EVENT_INBOX_OPENWA_REQUEST_TIMEOUT_MS: 10_000,
      EVENT_INBOX_OPENWA_RESPONSE_MAX_BYTES: 4_194_304,
      EVENT_INBOX_HTTP_REQUEST_TIMEOUT_MS: 30_000,
      EVENT_INBOX_HTTP_HEADERS_TIMEOUT_MS: 10_000,
    });
    expect(() => parseEventInboxConfig({
      ...configEnvironment(),
      EVENT_INBOX_DATABASE_URL: 'redis://redis.test:6379',
    })).toThrow('must use PostgreSQL');
    expect(() => parseEventInboxConfig({
      ...configEnvironment(),
      EVENT_INBOX_HTTP_REQUEST_TIMEOUT_MS: '5000',
      EVENT_INBOX_HTTP_HEADERS_TIMEOUT_MS: '5001',
    })).toThrow('cannot exceed');
    expect(parseEventInboxConfig({
      ...configEnvironment(),
      EVENT_INBOX_MAX_STORED_EVENTS: '5000000',
    }).EVENT_INBOX_MAX_STORED_EVENTS).toBe(5_000_000);
    expect(() => parseEventInboxConfig({
      ...configEnvironment(),
      EVENT_INBOX_MAX_STORED_EVENTS: '5000001',
    })).toThrow();
    expect(() => parseEventInboxConfig({
      ...configEnvironment(),
      EVENT_INBOX_OPENWA_RELEASE_TAG: 'unreviewed-release',
    })).toThrow(`must match reviewed release ${OPENWA_RELEASE_TAG}`);
    expect(() => parseEventInboxConfig({
      ...configEnvironment(),
      EVENT_INBOX_MAX_STORED_BYTES: '1048576',
      EVENT_INBOX_MAX_PAYLOAD_BYTES: '1048576',
    })).toThrow('must reserve one maximum-sized signed webhook');
  });

  it('requires an independent metrics credential for production', () => {
    expect(() => parseEventInboxConfig({
      ...configEnvironment(),
      NODE_ENV: 'production',
      EVENT_INBOX_PUBLIC_BASE_URL: 'https://events.example.test',
      EVENT_INBOX_OPENWA_BASE_URL: 'https://openwa.example.test',
    })).toThrow('EVENT_INBOX_METRICS_TOKEN is required in production');
    expect(() => parseEventInboxConfig({
      ...configEnvironment(),
      EVENT_INBOX_METRICS_TOKEN: masterSecret,
    })).toThrow('must be different from EVENT_INBOX_MASTER_SECRET');
    expect(parseEventInboxConfig({
      ...configEnvironment(),
      NODE_ENV: 'production',
      EVENT_INBOX_PUBLIC_BASE_URL: 'https://events.example.test',
      EVENT_INBOX_OPENWA_BASE_URL: 'https://openwa.example.test',
      EVENT_INBOX_METRICS_TOKEN: 'independent-event-inbox-metrics-token-0000000',
    }).EVENT_INBOX_METRICS_TOKEN).toBe('independent-event-inbox-metrics-token-0000000');
  });

  it('issues expiring v2 tokens and accepts v1 only inside an explicit fixed grace window', () => {
    const tokens = new EventInboxTokenService(config());
    const issuedAt = new Date();
    const v2 = tokens.issueDeviceToken(
      deviceId,
      3,
      issuedAt,
      new Date(issuedAt.getTime() + 86_400_000),
    );
    expect(tokens.authenticate(`Bearer ${v2}`)).toMatchObject({
      version: 2,
      deviceId,
      tokenGeneration: 3,
    });

    const legacy = issueLegacyDeviceToken(deviceId, [sessionId]);
    expect(() => tokens.authenticate(`Bearer ${legacy}`))
      .toThrow('Invalid Event Inbox device token');
    const graceConfig = parseEventInboxConfig({
      ...configEnvironment(),
      EVENT_INBOX_V1_ACCEPT_UNTIL: '2099-01-01T00:00:00.000Z',
    });
    expect(new EventInboxTokenService(graceConfig).authenticate(`Bearer ${legacy}`))
      .toMatchObject({ version: 1, deviceId, sessionIds: [sessionId] });
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

    repository.insert.mockResolvedValueOnce('conflict');
    await expect(controller.receive({ rawBody, body: envelope } as never, signature))
      .rejects.toThrow('idempotency key conflicts with a different payload');
  });

  it('pairs from verified OpenWA credentials and scopes claim/ACK/NACK to a device token', async () => {
    const receiptHandle = encodeEventInboxReceipt({ idempotencyKey: 'event-1', leaseId: crypto.randomUUID() });
    const repository = {
      claim: vi.fn().mockResolvedValue([{ idempotencyKey: 'event-1', receiptHandle }]),
      acknowledge: vi.fn().mockResolvedValue(1),
      negativelyAcknowledge: vi.fn().mockResolvedValue({ retried: 0, dead: 1 }),
    };
    const openwa = { validateCredentials: vi.fn().mockResolvedValue([sessionId]) };
    const pairingRateLimit = {
      consume: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 300 }),
    };
    const devices = {
      pair: vi.fn().mockResolvedValue({
        deviceId,
        tokenGeneration: 1,
        issuedAt: new Date('2026-08-22T00:00:00Z'),
        expiresAt: new Date('2027-08-22T00:00:00Z'),
        sessionIds: [sessionId],
      }),
      authorize: vi.fn().mockResolvedValue({
        deviceId,
        tokenGeneration: 1,
        tokenVersion: 2,
        sessionIds: [sessionId],
      }),
      authorizeRetirement: vi.fn().mockResolvedValue({
        deviceId,
        tokenGeneration: 1,
        tokenVersion: 2,
        sessionIds: [],
      }),
      revoke: vi.fn().mockResolvedValue(true),
    };
    const tokens = new EventInboxTokenService(config());
    const controller = new EventInboxController(
      repository as unknown as EventInboxRepository,
      tokens,
      devices as unknown as EventInboxDeviceRepository,
      openwa as unknown as EventInboxOpenWAClient,
      pairingRateLimit as unknown as EventInboxPairRateLimitService,
      config(),
    );
    const pairing = await controller.pair({
      openwaBaseUrl: 'http://127.0.0.1:2785', openwaApiKey: 'openwa-key', deviceId,
    }, '203.0.113.10', { setHeader: vi.fn() } as never);

    expect(pairing).toMatchObject({
      protocolVersion: 2,
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
    await expect(controller.revoke(authorization)).resolves.toEqual({ revoked: true });
    expect(devices.authorizeRetirement).toHaveBeenCalledOnce();
    await expect(controller.claim('Bearer invalid', { limit: 10, waitSeconds: 0 }))
      .rejects.toThrow('Invalid Event Inbox device token');
  });

  it('rate limits pairing before validating credentials and returns Retry-After', async () => {
    const openwa = { validateCredentials: vi.fn() };
    const pairingRateLimit = {
      consume: vi.fn().mockResolvedValue({ allowed: false, retryAfterSeconds: 127 }),
    };
    const response = { setHeader: vi.fn() };
    const controller = new EventInboxController(
      {} as EventInboxRepository,
      new EventInboxTokenService(config()),
      {} as EventInboxDeviceRepository,
      openwa as unknown as EventInboxOpenWAClient,
      pairingRateLimit as unknown as EventInboxPairRateLimitService,
      config(),
    );

    await expect(controller.pair({}, '203.0.113.10', response as never))
      .rejects.toMatchObject({ status: 429 });
    expect(pairingRateLimit.consume).toHaveBeenCalledWith('203.0.113.10');
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '127');
    expect(openwa.validateCredentials).not.toHaveBeenCalled();
  });

  it('fails readiness when it cannot admit one maximum-sized webhook', async () => {
    const readiness = {
      migrationHead: '014_event_inbox_active_lease_index.sql',
      migrationCount: 14,
      storedEvents: 99,
      storedBytes: 500,
      pendingEvents: 0,
      leasedEvents: 0,
      deadEvents: 0,
      retainedReceipts: 0,
      oldestPendingAgeSeconds: null,
      activeDevices: 1,
      legacyDevices: 0,
      ownedSessions: 1,
      activeRateLimitBuckets: 0,
      rateLimitedPairingAttempts: 0,
      maxStoredEvents: 100,
      maxStoredBytes: 1_000,
    };
    const repository = { readiness: vi.fn().mockResolvedValue(readiness) };
    const response = { status: vi.fn().mockReturnThis() };
    const controller = new EventInboxHealthController(
      repository as unknown as EventInboxRepository,
      config(),
    );

    await expect(controller.ready(response as never)).resolves.toMatchObject({
      status: 'not_ready',
      webhookAdmission: {
        available: false,
        eventSlotsRemaining: 1,
        byteHeadroom: 500,
        requiredByteHeadroom: 262_215,
      },
    });
    expect(response.status).toHaveBeenCalledWith(503);

    repository.readiness.mockResolvedValueOnce({
      ...readiness,
      storedEvents: 0,
      storedBytes: 0,
      maxStoredBytes: 1_000_000,
    });
    await expect(controller.ready(response as never)).resolves.toMatchObject({
      status: 'ready',
      webhookAdmission: { available: true },
    });
    expect(response.status).toHaveBeenLastCalledWith(200);
  });

  it('uses durable global and privacy-preserving per-IP pairing buckets', async () => {
    const repository = {
      consumeRateLimit: vi.fn()
        .mockResolvedValueOnce({ allowed: true, retryAfterSeconds: 300 })
        .mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 219 }),
    };
    const limiter = new EventInboxPairRateLimitService(
      repository as unknown as EventInboxRepository,
      config(),
    );

    await expect(limiter.consume('203.0.113.10')).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 219,
    });
    expect(repository.consumeRateLimit).toHaveBeenNthCalledWith(
      1,
      'pair-global',
      expect.any(Buffer),
      100,
      300,
    );
    expect(repository.consumeRateLimit).toHaveBeenNthCalledWith(
      2,
      'pair-ip',
      expect.any(Buffer),
      5,
      300,
    );
    const ipHash = repository.consumeRateLimit.mock.calls[1]?.[1] as Buffer;
    expect(ipHash).toHaveLength(32);
    expect(ipHash.includes(Buffer.from('203.0.113.10'))).toBe(false);
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

function issueLegacyDeviceToken(id: string, sessionIds: string[]): string {
  const payload = Buffer.from(JSON.stringify({ version: 1, deviceId: id, sessionIds }), 'utf8')
    .toString('base64url');
  return `${payload}.${createHmac('sha256', masterSecret)
    .update(`device-token:v1:${payload}`)
    .digest('base64url')}`;
}
