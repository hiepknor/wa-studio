import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { parseRuntimeConfig } from '../../src/core/config/runtime-config';
import {
  OpenWAConnectorIngressError,
  type OpenWAConnectorIngressClient,
} from '../../src/integrations/openwa/openwa-connector-ingress.client';
import { OpenWAConnectorCommandDispatcherService } from '../../src/modules/messages/openwa-connector-command-dispatcher.service';
import type {
  ClaimedOpenWAConnectorCommand,
  OpenWAConnectorCommandRepository,
} from '../../src/modules/messages/openwa-connector-command.repository';

const config = parseRuntimeConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://runtime:runtime@postgres.test:5432/runtime',
  REDIS_URL: 'redis://redis.test:6379',
  RUNTIME_API_KEY: 'runtime-key-with-at-least-32-characters',
  OPENWA_BASE_URL: 'http://openwa.test:2785',
  OPENWA_API_KEY: 'openwa-key',
  OPENWA_WEBHOOK_SECRET: 'webhook-secret-with-at-least-32-characters',
  OPENWA_ALLOWED_SESSION_IDS: '00000000-0000-4000-8000-000000000001',
  EVENT_INBOX_BASE_URL: 'http://127.0.0.1:34200',
  EVENT_INBOX_DEVICE_TOKEN: 'device-token-with-at-least-32-characters',
  EVENT_INBOX_CONNECTOR_REQUIRED_FOR_LIVE_SENDS: 'true',
  OPENWA_WEBHOOK_RECONCILIATION_ENABLED: 'true',
  OPENWA_WEBHOOK_CALLBACK_URL: 'http://127.0.0.1:34200/api/v1/webhooks/openwa',
  OPENWA_CONNECTOR_INSTANCE_ID: 'instance-1',
  OPENWA_CONNECTOR_INGRESS_SECRET: 'connector-ingress-secret-with-at-least-32-characters',
  OPENWA_CONNECTOR_MAX_INGRESS_ATTEMPTS: '3',
});

function claimed(overrides: Partial<ClaimedOpenWAConnectorCommand> = {}): ClaimedOpenWAConnectorCommand {
  const body = Buffer.from('{"command":true}');
  return {
    attemptId: '00000000-0000-4000-8000-000000000001',
    commandId: '00000000-0000-4000-8000-000000000002',
    messageJobId: '00000000-0000-4000-8000-000000000003',
    leaseId: '00000000-0000-4000-8000-000000000004',
    body,
    payloadSha256: createHash('sha256').update(body).digest('hex'),
    expiresAt: new Date(Date.now() + 60_000),
    deliveryAttempt: 1,
    ...overrides,
  };
}

function harness(command: ClaimedOpenWAConnectorCommand, submit: ReturnType<typeof vi.fn>) {
  const commands = {
    settleExpired: vi.fn().mockResolvedValue({ failed: 0, indeterminate: 0 }),
    settleEvidenceTimeout: vi.fn().mockResolvedValue(0),
    claimDue: vi.fn().mockResolvedValue([command]),
    markAccepted: vi.fn().mockResolvedValue(true),
    settleDefinitive: vi.fn().mockResolvedValue(true),
    settleIndeterminate: vi.fn().mockResolvedValue(true),
    rescheduleSafeRejection: vi.fn().mockResolvedValue(true),
    reschedule: vi.fn().mockResolvedValue(true),
  };
  return {
    commands,
    dispatcher: new OpenWAConnectorCommandDispatcherService(
      commands as unknown as OpenWAConnectorCommandRepository,
      { submit } as unknown as OpenWAConnectorIngressClient,
      config,
    ),
  };
}

describe('OpenWAConnectorCommandDispatcherService', () => {
  it('settles expired dispatches and missing evidence before claiming new work', async () => {
    const command = claimed();
    const submit = vi.fn().mockResolvedValue({ duplicate: false });
    const { commands, dispatcher } = harness(command, submit);

    await dispatcher.run();

    expect(commands.settleExpired).toHaveBeenCalledWith(
      config.OPENWA_CONNECTOR_DISPATCH_BATCH_SIZE,
    );
    expect(commands.settleEvidenceTimeout).toHaveBeenCalledWith(
      config.OPENWA_CONNECTOR_DISPATCH_BATCH_SIZE,
      config.OPENWA_CONNECTOR_EVIDENCE_TIMEOUT_SECONDS * 1_000,
    );
    expect(commands.claimDue).toHaveBeenCalledWith({
      limit: config.OPENWA_CONNECTOR_DISPATCH_BATCH_SIZE,
      leaseMs: config.OPENWA_CONNECTOR_DISPATCH_LEASE_MS,
      maximumAttempts: config.OPENWA_CONNECTOR_MAX_INGRESS_ATTEMPTS,
    });
    expect(submit).toHaveBeenCalledOnce();
  });

  it('marks a command accepted only after the ingress acknowledges its exact bytes', async () => {
    const command = claimed();
    const submit = vi.fn().mockResolvedValue({ duplicate: false });
    const { commands, dispatcher } = harness(command, submit);

    await expect(dispatcher.dispatchAttempt(command.attemptId)).resolves.toBe(true);

    expect(submit).toHaveBeenCalledWith({ commandId: command.commandId, body: command.body });
    expect(commands.markAccepted).toHaveBeenCalledWith(command);
    expect(commands.reschedule).not.toHaveBeenCalled();
  });

  it('fails closed when the persisted command digest is corrupt', async () => {
    const command = claimed({ payloadSha256: '0'.repeat(64) });
    const submit = vi.fn();
    const { commands, dispatcher } = harness(command, submit);

    await dispatcher.dispatchAttempt(command.attemptId);

    expect(submit).not.toHaveBeenCalled();
    expect(commands.settleDefinitive).toHaveBeenCalledWith(
      command,
      'Connector command payload digest is corrupt',
    );
  });

  it('retries the same command for an ambiguous ingress response before expiry', async () => {
    const command = claimed();
    const error = new OpenWAConnectorIngressError('AMBIGUOUS_RETRYABLE', 503, null, 'unavailable');
    const { commands, dispatcher } = harness(command, vi.fn().mockRejectedValue(error));

    await dispatcher.dispatchAttempt(command.attemptId);

    expect(commands.reschedule).toHaveBeenCalledWith(
      command,
      error.message,
      'AMBIGUOUS_RETRYABLE',
      expect.any(Number),
    );
    expect(commands.settleIndeterminate).not.toHaveBeenCalled();
  });

  it('creates a business retry only for an explicit safe rate-limit rejection', async () => {
    const command = claimed({ deliveryAttempt: config.OPENWA_CONNECTOR_MAX_INGRESS_ATTEMPTS });
    const error = new OpenWAConnectorIngressError('RATE_LIMITED_SAFE', 429, 5_000, 'limited');
    const { commands, dispatcher } = harness(command, vi.fn().mockRejectedValue(error));

    await dispatcher.dispatchAttempt(command.attemptId);

    expect(commands.rescheduleSafeRejection).toHaveBeenCalledWith(
      command,
      error.message,
      expect.any(Number),
    );
    expect(commands.settleIndeterminate).not.toHaveBeenCalled();
  });

  it('never creates a new identity when an ambiguous ingress command is exhausted', async () => {
    const command = claimed({ deliveryAttempt: config.OPENWA_CONNECTOR_MAX_INGRESS_ATTEMPTS });
    const error = new OpenWAConnectorIngressError('AMBIGUOUS_RETRYABLE', 503, null, 'unavailable');
    const { commands, dispatcher } = harness(command, vi.fn().mockRejectedValue(error));

    await dispatcher.dispatchAttempt(command.attemptId);

    expect(commands.settleIndeterminate).toHaveBeenCalledWith(command, error.message);
    expect(commands.rescheduleSafeRejection).not.toHaveBeenCalled();
  });
});
