import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenWAClient } from '../../src/integrations/openwa/openwa.client';
import {
  RUNTIME_OPENWA_WEBHOOK_EVENTS,
  WebhookRegistrationReconciliationTick,
} from '../../src/modules/webhooks/webhook-registration-reconciliation.tick';

const callbackUrl = 'https://runtime.example.test/api/v1/webhooks/openwa';
const secret = 'test-secret-at-least-thirty-two-characters';

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
    await new WebhookRegistrationReconciliationTick(openwa as unknown as OpenWAClient, {
      enabled: false,
      callbackUrl: null,
      secret,
      allowedSessionIds: ['session-one'],
    }).run();

    expect(openwa.reconcileWebhookRegistration).not.toHaveBeenCalled();
  });

  it('delegates one bounded desired-state reconciliation per session', async () => {
    const openwa = client();
    openwa.reconcileWebhookRegistration.mockResolvedValue({ created: 1, updated: 0, deleted: 0 });

    await new WebhookRegistrationReconciliationTick(openwa as unknown as OpenWAClient, {
      enabled: true,
      callbackUrl,
      secret,
      allowedSessionIds: ['session-one'],
    }).run();

    expect(openwa.reconcileWebhookRegistration).toHaveBeenCalledWith({
      sessionId: 'session-one',
      url: callbackUrl,
      events: [...RUNTIME_OPENWA_WEBHOOK_EVENTS],
      secret,
      retryCount: 3,
    });
  });

  it('isolates a session failure, converges the next session and logs only aggregate data', async () => {
    const openwa = client();
    openwa.reconcileWebhookRegistration
      .mockRejectedValueOnce(new Error('failure containing sensitive-session-one'))
      .mockResolvedValueOnce({ created: 1, updated: 0, deleted: 0 });
    const warning = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const tick = new WebhookRegistrationReconciliationTick(openwa as unknown as OpenWAClient, {
      enabled: true,
      callbackUrl,
      secret,
      allowedSessionIds: ['sensitive-session-one', 'sensitive-session-two'],
    });

    await expect(tick.run()).rejects.toThrow('failed for 1 session(s)');
    expect(openwa.reconcileWebhookRegistration).toHaveBeenCalledTimes(2);
    expect(openwa.reconcileWebhookRegistration).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sensitive-session-two',
    }));
    expect(JSON.stringify(warning.mock.calls)).not.toContain('sensitive-session');
    expect(JSON.stringify(warning.mock.calls)).not.toContain(callbackUrl);
  });
});
