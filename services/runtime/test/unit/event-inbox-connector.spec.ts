import { describe, expect, it, vi } from 'vitest';
import {
  EVENT_INBOX_CONNECTOR_PROTOCOL_VERSION,
} from '../../src/contracts/event-inbox';
import { parseEventInboxConfig } from '../../src/core/event-inbox/event-inbox-config';
import { EventInboxTokenService } from '../../src/core/event-inbox/event-inbox-token.service';
import { verifySha256Hmac } from '../../src/core/security/hmac-signature';
import { EventInboxConnectorController } from '../../src/modules/event-inbox/event-inbox-connector.controller';
import type { EventInboxConnectorRepository } from '../../src/modules/event-inbox/event-inbox-connector.repository';
import type { EventInboxDeviceRepository } from '../../src/modules/event-inbox/event-inbox-device.repository';
import type { EventInboxRepository } from '../../src/modules/event-inbox/event-inbox.repository';

const sessionId = '00000000-0000-4000-8000-000000000001';
const deviceId = '00000000-0000-4000-8000-000000000002';
const connectorId = '00000000-0000-4000-8000-000000000003';
const config = parseEventInboxConfig({
  NODE_ENV: 'test',
  EVENT_INBOX_DATABASE_URL: 'postgresql://events:events@postgres.test:5432/events',
  EVENT_INBOX_MASTER_SECRET: 'event-inbox-master-secret-with-at-least-32-characters',
  EVENT_INBOX_PUBLIC_BASE_URL: 'http://127.0.0.1:34200',
  EVENT_INBOX_OPENWA_BASE_URL: 'http://127.0.0.1:2785',
  EVENT_INBOX_ALLOWED_SESSION_IDS: sessionId,
});

describe('Event Inbox connector boundary', () => {
  it('provisions, binds and reports connector health through device authorization', async () => {
    const tokens = new EventInboxTokenService(config);
    const deviceToken = tokens.issueDeviceToken(
      deviceId,
      1,
      new Date('2026-08-31T00:00:00.000Z'),
      new Date('2027-08-31T00:00:00.000Z'),
    );
    const devices = {
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
    };
    const binding = {
      sessionId,
      connectorId,
      webhookId: 'webhook-1',
      generation: 1,
      updatedAt: '2026-08-31T00:00:00.000Z',
    };
    const connectors = {
      provision: vi.fn().mockResolvedValue({ connectorId, token: 'connector-token', sessionIds: [sessionId] }),
      putPreparedCredential: vi.fn().mockResolvedValue({
        connectorId,
        tokenGeneration: 1,
        sessionIds: [sessionId],
        outcome: 'CREATED',
      }),
      rotate: vi.fn().mockResolvedValue({ connectorId, token: 'rotated-token', sessionIds: [sessionId] }),
      revoke: vi.fn().mockResolvedValue(true),
      setBinding: vi.fn().mockResolvedValue(binding),
      status: vi.fn().mockResolvedValue([{ sessionId, binding, connector: null }]),
      authenticate: vi.fn().mockResolvedValue({ connectorId, deviceId, tokenGeneration: 1, sessionIds: [sessionId] }),
      recordHeartbeat: vi.fn().mockResolvedValue([binding]),
      authorizeDelivery: vi.fn().mockResolvedValue(true),
    };
    const events = { insert: vi.fn().mockResolvedValue('created') };
    const controller = new EventInboxConnectorController(
      connectors as unknown as EventInboxConnectorRepository,
      events as unknown as EventInboxRepository,
      tokens,
      devices as unknown as EventInboxDeviceRepository,
    );
    const deviceAuthorization = `Bearer ${deviceToken}`;

    await expect(controller.provision(deviceAuthorization, { sessionIds: [sessionId] }))
      .resolves.toMatchObject({
        protocolVersion: EVENT_INBOX_CONNECTOR_PROTOCOL_VERSION,
        connectorId,
      });
    await expect(controller.putPreparedCredential(
      deviceAuthorization,
      connectorId,
      '1',
      { sessionIds: [sessionId], secretSha256: 'a'.repeat(64) },
    )).resolves.toMatchObject({
      protocolVersion: EVENT_INBOX_CONNECTOR_PROTOCOL_VERSION,
      connectorId,
      tokenGeneration: 1,
      outcome: 'CREATED',
    });
    await expect(controller.setBinding(deviceAuthorization, sessionId, {
      connectorId, webhookId: 'webhook-1', generation: 1,
    })).resolves.toEqual(binding);
    await expect(controller.status(deviceAuthorization)).resolves.toMatchObject({
      protocolVersion: EVENT_INBOX_CONNECTOR_PROTOCOL_VERSION,
      sessions: [{ sessionId }],
    });
    await expect(controller.rotate(deviceAuthorization, { connectorId }))
      .resolves.toMatchObject({ connectorId, token: 'rotated-token' });
    await expect(controller.revoke(deviceAuthorization, { connectorId }))
      .resolves.toEqual({ revoked: true });
    expect(devices.authorizeRetirement).toHaveBeenCalledOnce();

    const heartbeat = {
      pluginVersion: '1.0.0',
      protocolVersion: 1,
      journalSchemaVersion: 1,
      sessions: [{
        sessionId,
        bindingGeneration: 1,
        pendingCount: 0,
        oldestPendingSeconds: null,
        storageUtilization: 0.1,
        blockedReason: null,
      }],
    };
    await expect(controller.heartbeat('Bearer connector-token', heartbeat))
      .resolves.toMatchObject({ bindings: [binding] });
  });

  it('accepts only connector events matching an authorized binding generation', async () => {
    const tokens = new EventInboxTokenService(config);
    const connector = { connectorId, deviceId, tokenGeneration: 1, sessionIds: [sessionId] };
    const connectors = {
      authenticate: vi.fn().mockResolvedValue(connector),
      authorizeDelivery: vi.fn().mockResolvedValue(true),
    };
    const events = { insert: vi.fn().mockResolvedValue('created') };
    const controller = new EventInboxConnectorController(
      connectors as unknown as EventInboxConnectorRepository,
      events as unknown as EventInboxRepository,
      tokens,
      {} as EventInboxDeviceRepository,
    );
    const envelope = {
      event: 'message.sent',
      timestamp: '2026-08-31T00:00:00.000Z',
      sessionId,
      idempotencyKey: 'event-1_webhook-1',
      deliveryId: 'delivery-1',
      data: { id: 'message-1' },
    };

    await expect(controller.receiveEvent('Bearer connector-token', {
      bindingGeneration: 1,
      envelope,
    })).resolves.toEqual({ accepted: true, duplicate: false });
    const [rawBody, signature] = events.insert.mock.calls[0]!;
    expect(JSON.parse((rawBody as Buffer).toString('utf8'))).toEqual(envelope);
    expect(verifySha256Hmac(rawBody as Buffer, signature as string, tokens.webhookSecret())).toBe(true);

    connectors.authorizeDelivery.mockResolvedValueOnce(false);
    await expect(controller.receiveEvent('Bearer connector-token', {
      bindingGeneration: 2,
      envelope,
    })).rejects.toThrow('does not match an authorized connector binding generation');
  });

  it('binds delivery evidence identity to its connector envelope', async () => {
    const tokens = new EventInboxTokenService(config);
    const connectors = {
      authenticate: vi.fn().mockResolvedValue({
        connectorId, deviceId, tokenGeneration: 1, sessionIds: [sessionId],
      }),
      authorizeDelivery: vi.fn().mockResolvedValue(true),
    };
    const events = { insert: vi.fn().mockResolvedValue('created') };
    const controller = new EventInboxConnectorController(
      connectors as unknown as EventInboxConnectorRepository,
      events as unknown as EventInboxRepository,
      tokens,
      {} as EventInboxDeviceRepository,
    );
    const eventId = 'f698b26a-b23d-414d-be67-e09b127d6cc8';
    const evidence = {
      protocolVersion: 1,
      eventId,
      commandId: '760ba9a3-606c-4ceb-83ba-d6ea46e73fc1',
      attemptId: '9551a035-740f-4c01-b234-b1306de2fba8',
      sessionId,
      sequence: 1,
      kind: 'COMMAND_RECEIVED',
      openwaMessageId: null,
      deliveryStatus: 'PENDING',
      errorClass: null,
      errorCode: null,
      bindingGeneration: 1,
      pluginVersion: '1.0.0',
      occurredAt: '2026-08-31T10:00:00.000Z',
      payloadSha256: 'b'.repeat(64),
    };
    const validEnvelope = {
      event: 'wa-studio.connector.evidence',
      timestamp: evidence.occurredAt,
      sessionId,
      idempotencyKey: `${eventId}_webhook-1`,
      deliveryId: eventId,
      data: evidence,
    };

    await expect(controller.receiveEvent('Bearer connector-token', {
      bindingGeneration: 1,
      envelope: validEnvelope,
    })).resolves.toEqual({ accepted: true, duplicate: false });
    expect(JSON.parse((events.insert.mock.calls[0]![0] as Buffer).toString('utf8')).data)
      .toEqual(evidence);

    await expect(controller.receiveEvent('Bearer connector-token', {
      bindingGeneration: 1,
      envelope: { ...validEnvelope, deliveryId: '00000000-0000-4000-8000-000000000099' },
    })).rejects.toThrow('identity does not match its envelope');
    expect(events.insert).toHaveBeenCalledOnce();
  });
});
