import { describe, expect, it, vi } from 'vitest';
import { parseRuntimeConfig } from '../../src/core/config/runtime-config';
import type { DatabaseService } from '../../src/core/database/database.service';
import { RuntimeDispatchReadinessService } from '../../src/core/dispatch-readiness/runtime-dispatch-readiness.service';
import { OpenWASafetyGovernorService } from '../../src/integrations/openwa/safety/openwa-safety-governor.service';
import type { OpenWASafetyRepository } from '../../src/integrations/openwa/safety/openwa-safety.repository';

const sessionId = '00000000-0000-4000-8000-000000000001';

function config(eventInbox = true) {
  return parseRuntimeConfig({
    NODE_ENV: 'test',
    RUNTIME_PROFILE: 'desktop-managed',
    QUEUE_BACKEND: 'postgres',
    DATABASE_URL: 'postgresql://runtime:runtime@postgres.test/runtime',
    RUNTIME_API_KEY: 'runtime-key-with-at-least-32-characters',
    OPENWA_BASE_URL: 'http://openwa.test:2785',
    OPENWA_API_KEY: 'openwa-key',
    OPENWA_WEBHOOK_SECRET: 'webhook-secret-with-at-least-32-characters',
    OPENWA_ALLOWED_SESSION_IDS: sessionId,
    ...(eventInbox ? {
      EVENT_INBOX_BASE_URL: 'http://127.0.0.1:34200',
      EVENT_INBOX_DEVICE_TOKEN: 'device-token-with-at-least-32-characters',
    } : {}),
  });
}

describe('RuntimeDispatchReadinessService', () => {
  it('is explicitly disabled without an Event Inbox dependency', async () => {
    const database = { query: vi.fn() };
    const service = new RuntimeDispatchReadinessService(
      database as unknown as DatabaseService,
      config(false),
    );

    await expect(service.snapshot()).resolves.toMatchObject({
      required: false,
      ready: true,
      state: 'DISABLED',
    });
    expect(database.query).not.toHaveBeenCalled();
  });

  it('fails closed when a persisted READY heartbeat is stale', async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [{
      state: 'READY',
      reason: null,
      recovery_watermark: '42',
      recovery_started_at: new Date('2026-09-04T00:00:00Z'),
      ready_at: new Date('2026-09-04T00:00:01Z'),
      heartbeat_at: new Date('2026-09-04T00:00:02Z'),
      ready: false,
    }] }) };
    const service = new RuntimeDispatchReadinessService(
      database as unknown as DatabaseService,
      config(),
    );

    await expect(service.snapshot()).resolves.toMatchObject({
      required: true,
      ready: false,
      state: 'DEGRADED',
      reason: 'event_inbox_consumer_heartbeat_stale',
      recoveryWatermark: '42',
    });
  });

  it('defers permit reservation before touching safety budgets when recovery is closed', async () => {
    const repository = { reserveMessage: vi.fn() };
    const readiness = { snapshot: vi.fn().mockResolvedValue({
      ready: false,
      reason: 'event_inbox_startup_recovery',
    }) };
    const governor = new OpenWASafetyGovernorService(
      repository as unknown as OpenWASafetyRepository,
      config(),
      readiness as unknown as RuntimeDispatchReadinessService,
    );

    await expect(governor.reserveMessage({
      sessionId,
      messageJobId: '00000000-0000-4000-8000-000000000002',
      recipientId: '120363000000000000@g.us',
      operationClass: 'MESSAGE_SEND_TEXT',
    })).resolves.toMatchObject({
      outcome: 'DEFERRED',
      reason: 'event_inbox_startup_recovery',
    });
    expect(repository.reserveMessage).not.toHaveBeenCalled();
  });
});
