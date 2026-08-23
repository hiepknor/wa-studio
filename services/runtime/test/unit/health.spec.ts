import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../src/core/database/database.service';
import type { QueueService } from '../../src/core/queue/queue.service';
import { HealthController } from '../../src/modules/health/health.controller';

vi.mock('../../src/core/config/runtime-config', () => ({
  runtimeConfig: () => ({
    ALLOW_LIVE_SENDS: false,
    OPENWA_RELEASE_TAG: '0.22.0',
    OPENWA_ALLOWED_SESSION_IDS: ['00000000-0000-4000-8000-000000000001'],
    RUNTIME_INSTANCE_ID: 'test-instance',
  }),
}));

describe('HealthController readiness', () => {
  it('reports the WA Runtime service identity', () => {
    const controller = new HealthController({} as DatabaseService, {} as QueueService);

    expect(controller.live()).toEqual({ status: 'ok', service: 'wa-runtime', version: '0.1.0' });
  });

  it('reports the selected Redis queue backend and healthy background processes', async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) };
    const queues = {
      readiness: vi.fn().mockResolvedValue({ backend: 'redis', ready: true }),
      runtimeProcessHealth: vi.fn().mockResolvedValue({ worker: 'healthy', scheduler: 'healthy' }),
    };
    const controller = new HealthController(
      database as unknown as DatabaseService,
      queues as unknown as QueueService,
    );

    await expect(controller.ready()).resolves.toMatchObject({
      status: 'ready',
      dependencies: {
        postgres: true,
        queue: { backend: 'redis', ready: true },
        redis: true,
      },
      processes: { worker: 'healthy', scheduler: 'healthy' },
    });
  });

  it('remains ready and reports degraded background processes when heartbeats are missing', async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const queues = {
      readiness: vi.fn().mockResolvedValue({ backend: 'postgres', ready: true }),
      runtimeProcessHealth: vi.fn().mockResolvedValue({ worker: 'degraded', scheduler: 'degraded' }),
    };
    const controller = new HealthController(
      database as unknown as DatabaseService,
      queues as unknown as QueueService,
    );

    await expect(controller.ready()).resolves.toMatchObject({
      status: 'ready',
      dependencies: {
        postgres: true,
        queue: { backend: 'postgres', ready: true },
      },
      processes: { worker: 'degraded', scheduler: 'degraded' },
    });
  });

  it('returns unavailable when the selected queue backend is unavailable', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const queues = {
      readiness: vi.fn().mockRejectedValue(new Error('Redis unavailable')),
      runtimeProcessHealth: vi.fn(),
    };
    const controller = new HealthController(
      database as unknown as DatabaseService,
      queues as unknown as QueueService,
    );

    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(queues.runtimeProcessHealth).not.toHaveBeenCalled();
  });

  it('returns unavailable when PostgreSQL is unavailable', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const database = { query: vi.fn().mockRejectedValue(new Error('PostgreSQL unavailable')) };
    const queues = { readiness: vi.fn(), runtimeProcessHealth: vi.fn() };
    const controller = new HealthController(
      database as unknown as DatabaseService,
      queues as unknown as QueueService,
    );

    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(queues.readiness).not.toHaveBeenCalled();
  });

  it('uses strict background health for the operational endpoint', async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const queues = {
      readiness: vi.fn().mockResolvedValue({ backend: 'postgres', ready: true }),
      runtimeProcessHealth: vi.fn().mockResolvedValue({ worker: 'healthy', scheduler: 'degraded' }),
    };
    const response = { status: vi.fn().mockReturnThis() };
    const controller = new HealthController(
      database as unknown as DatabaseService,
      queues as unknown as QueueService,
    );

    await expect(controller.operational(response as never)).resolves.toMatchObject({
      status: 'degraded',
      instanceId: 'test-instance',
      reason: 'background_process_degraded',
    });
    expect(response.status).toHaveBeenCalledWith(503);
  });
});
