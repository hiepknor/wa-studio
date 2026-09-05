import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenWAClient } from '../../src/integrations/openwa/openwa.client';
import {
  RUNTIME_OPENWA_OPERATIONAL_WEBHOOK_EVENTS,
  RUNTIME_OPENWA_WEBHOOK_EVENTS,
  WebhookRegistrationReconciliationTick,
  type WebhookRegistrationReconciliationOptions,
} from '../../src/modules/webhooks/webhook-registration-reconciliation.tick';

const callbackUrl = 'https://runtime.example.test/api/v1/webhooks/openwa';
const secret = 'test-secret-at-least-thirty-two-characters';
const connectorId = '00000000-0000-4000-8000-000000000002';
const pluginVersion = '1.0.0';

const options = (
  overrides: Partial<WebhookRegistrationReconciliationOptions> = {},
): WebhookRegistrationReconciliationOptions => ({
  enabled: true,
  callbackUrl,
  secret,
  allowedSessionIds: ['session-one'],
  expectedConnectorId: connectorId,
  expectedPluginVersion: pluginVersion,
  includeInboundMessages: true,
  ...overrides,
});

const client = () => ({
  reconcileWebhookRegistration: vi.fn(),
});

describe('WebhookRegistrationReconciliationTick', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('does not call OpenWA while disabled', async () => {
    const openwa = client();
    await new WebhookRegistrationReconciliationTick(
      openwa as unknown as OpenWAClient,
      options({ enabled: false, callbackUrl: null }),
    ).run();

    expect(openwa.reconcileWebhookRegistration).not.toHaveBeenCalled();
  });

  it('delegates one bounded desired-state reconciliation per session', async () => {
    const openwa = client();
    openwa.reconcileWebhookRegistration.mockResolvedValue({
      created: 1, updated: 0, deleted: 0, webhookId: 'webhook-one',
    });
    const connector = {
      status: vi.fn().mockResolvedValue({
        sessions: [{ sessionId: 'session-one', connector: { connectorId, pluginVersion } }],
      }),
      setBinding: vi.fn().mockResolvedValue({
        sessionId: 'session-one', connectorId, webhookId: 'webhook-one', generation: 1,
        updatedAt: '2026-09-04T00:00:00.000Z',
      }),
    };
    const connectorHealth = {
      stageBinding: vi.fn().mockResolvedValue({
        sessionId: 'session-one', connectorId, webhookId: 'webhook-one', generation: 1,
      }),
      markBindingSynced: vi.fn().mockResolvedValue(undefined),
    };

    await new WebhookRegistrationReconciliationTick(
      openwa as unknown as OpenWAClient,
      options(),
      connector as never,
      connectorHealth as never,
    ).run();

    expect(openwa.reconcileWebhookRegistration).toHaveBeenCalledWith({
      sessionId: 'session-one',
      url: callbackUrl,
      events: [...RUNTIME_OPENWA_WEBHOOK_EVENTS],
      secret,
      retryCount: 3,
    });
    expect(connectorHealth.stageBinding).toHaveBeenCalledWith(
      'session-one', connectorId, 'webhook-one',
    );
    expect(connector.setBinding).toHaveBeenCalledWith({
      sessionId: 'session-one', connectorId, webhookId: 'webhook-one', generation: 1,
    });
    expect(connectorHealth.markBindingSynced).toHaveBeenCalledTimes(1);
  });

  it('isolates a session failure, converges the next session and logs only aggregate data', async () => {
    const openwa = client();
    openwa.reconcileWebhookRegistration
      .mockRejectedValueOnce(new Error('failure containing sensitive-session-one'))
      .mockResolvedValueOnce({ created: 1, updated: 0, deleted: 0, webhookId: 'webhook-two' });
    const warning = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const tick = new WebhookRegistrationReconciliationTick(
      openwa as unknown as OpenWAClient,
      options({ allowedSessionIds: ['sensitive-session-one', 'sensitive-session-two'] }),
    );

    await expect(tick.run()).rejects.toThrow('failed for 1 session(s)');
    expect(openwa.reconcileWebhookRegistration).toHaveBeenCalledTimes(2);
    expect(openwa.reconcileWebhookRegistration).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sensitive-session-two',
    }));
    expect(JSON.stringify(warning.mock.calls)).not.toContain('sensitive-session');
    expect(JSON.stringify(warning.mock.calls)).not.toContain(callbackUrl);
  });

  it('omits inbound messages when compact desktop storage is disabled', async () => {
    const openwa = client();
    openwa.reconcileWebhookRegistration.mockResolvedValue({
      created: 0, updated: 1, deleted: 0, webhookId: 'webhook-one',
    });

    await new WebhookRegistrationReconciliationTick(
      openwa as unknown as OpenWAClient,
      options({ includeInboundMessages: false }),
    ).run();

    expect(RUNTIME_OPENWA_OPERATIONAL_WEBHOOK_EVENTS).toEqual([
      'message.sent', 'message.ack', 'message.failed',
      'session.status', 'session.restriction',
      'group.join', 'group.leave', 'group.update',
    ]);
    expect(openwa.reconcileWebhookRegistration).toHaveBeenCalledWith({
      sessionId: 'session-one',
      url: callbackUrl,
      events: [...RUNTIME_OPENWA_OPERATIONAL_WEBHOOK_EVENTS],
      secret,
      retryCount: 3,
    });
  });

  it('does not mark a binding synchronized when the acknowledgement identity differs', async () => {
    const openwa = client();
    openwa.reconcileWebhookRegistration.mockResolvedValue({
      created: 0, updated: 0, deleted: 0, webhookId: 'webhook-one',
    });
    const connector = {
      status: vi.fn().mockResolvedValue({
        sessions: [{ sessionId: 'session-one', connector: { connectorId, pluginVersion } }],
      }),
      setBinding: vi.fn().mockResolvedValue({
        sessionId: 'session-one',
        connectorId: '00000000-0000-4000-8000-000000000099',
        webhookId: 'webhook-one',
        generation: 1,
        updatedAt: '2026-09-04T00:00:00.000Z',
      }),
    };
    const connectorHealth = {
      stageBinding: vi.fn().mockResolvedValue({
        sessionId: 'session-one', connectorId, webhookId: 'webhook-one', generation: 1,
      }),
      markBindingSynced: vi.fn(),
    };

    await expect(new WebhookRegistrationReconciliationTick(
      openwa as unknown as OpenWAClient,
      options(),
      connector as never,
      connectorHealth as never,
    ).run()).rejects.toThrow('failed for 1 session(s)');
    expect(connectorHealth.markBindingSynced).not.toHaveBeenCalled();
  });
});
