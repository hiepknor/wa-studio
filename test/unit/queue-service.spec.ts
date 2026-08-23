import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

const connections: Array<{
  on: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
  mget: ReturnType<typeof vi.fn>;
}> = [];
const queueInstances: Array<{
  name: string;
  add: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('ioredis', () => ({
  default: class RedisMock {
    on = vi.fn();
    disconnect = vi.fn();
    ping = vi.fn().mockResolvedValue('PONG');
    mget = vi.fn().mockResolvedValue([null, null]);
    status = 'ready';

    constructor() {
      connections.push(this);
    }
  },
}));

vi.mock('bullmq', () => ({
  Queue: class QueueMock {
    add = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);

    constructor(readonly name: string) {
      queueInstances.push(this);
    }
  },
}));

vi.mock('../../src/core/config/runtime-config', () => ({
  runtimeConfig: () => ({ REDIS_URL: 'redis://redis.test:6379' }),
}));

describe('QueueService Redis connection logging', () => {
  afterEach(() => {
    connections.length = 0;
    queueInstances.length = 0;
    vi.restoreAllMocks();
  });

  it('routes transport-neutral publications to the selected Redis queue', async () => {
    const { QueueService } = await import('../../src/core/queue/queue.service');
    const service = new QueueService();

    await service.publish(
      'gateway-sync',
      'full-session-sync',
      { syncRunId: 'run-1' },
      { jobId: 'run-1', attempts: 1 },
    );

    const gateway = queueInstances.find(queue => queue.name === 'gateway-sync');
    expect(gateway?.add).toHaveBeenCalledWith(
      'full-session-sync',
      { syncRunId: 'run-1' },
      { jobId: 'run-1', attempts: 1 },
    );
    await service.onApplicationShutdown();
  });

  it('attaches structured error handlers without exposing the Redis URL', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { QueueService } = await import('../../src/core/queue/queue.service');
    const service = new QueueService();

    expect(connections).toHaveLength(2);
    for (const connection of connections) {
      expect(connection.on).toHaveBeenCalledWith('error', expect.any(Function));
    }
    const handler = connections[0]!.on.mock.calls.find(call => call[0] === 'error')?.[1] as (error: Error) => void;
    handler(Object.assign(new Error('connect ECONNREFUSED redis://secret@redis.test'), { code: 'ECONNREFUSED' }));

    expect(warn).toHaveBeenCalledWith({
      event: 'redis.connection.error', connection: 'queue', code: 'ECONNREFUSED',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('redis://');
    await service.onApplicationShutdown();
  });

  it('keeps Redis readiness separate from background process health', async () => {
    const { QueueService } = await import('../../src/core/queue/queue.service');
    const service = new QueueService();

    await expect(service.readiness()).resolves.toEqual({ backend: 'redis', ready: true });
    await expect(service.runtimeProcessHealth()).resolves.toEqual({
      worker: 'degraded', scheduler: 'degraded',
    });

    const healthConnection = connections[1]!;
    healthConnection.mget.mockResolvedValueOnce(['worker-heartbeat', 'scheduler-heartbeat']);
    await expect(service.runtimeProcessHealth()).resolves.toEqual({
      worker: 'healthy', scheduler: 'healthy',
    });
    await service.onApplicationShutdown();
  });
});
