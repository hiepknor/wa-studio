import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../../src/core/config/runtime-config';

const mocks = vi.hoisted(() => ({
  workerClose: vi.fn<() => Promise<void>>(),
  queueClose: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = vi.fn().mockResolvedValue(undefined);
    close = mocks.queueClose;
  },
  Worker: class {
    close = mocks.workerClose;
    on = vi.fn();
  },
}));

vi.mock('ioredis', () => ({
  default: class {
    status = 'ready';
    on = vi.fn();
    disconnect = mocks.disconnect;
    connect = vi.fn().mockResolvedValue(undefined);
    ping = vi.fn().mockResolvedValue('PONG');
    set = vi.fn().mockResolvedValue('OK');
    mget = vi.fn().mockResolvedValue([null, null]);
  },
}));

import { RedisQueueTransport } from '../../src/core/queue/redis-queue.transport';

describe('RedisQueueTransport', () => {
  it('shares worker drain across handle and transport close callers', async () => {
    let release!: () => void;
    mocks.workerClose.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const transport = new RedisQueueTransport({ REDIS_URL: 'redis://queue.test:6379' } as RuntimeConfig);
    const worker = transport.startWorker(
      'message-send',
      1,
      vi.fn().mockResolvedValue(undefined),
      vi.fn(),
    );

    let workerClosed = false;
    let transportClosed = false;
    const closingWorker = worker.close().then(() => { workerClosed = true; });
    const closingTransport = transport.close().then(() => { transportClosed = true; });
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.workerClose).toHaveBeenCalledOnce();
    expect(workerClosed).toBe(false);
    expect(transportClosed).toBe(false);
    expect(mocks.disconnect).not.toHaveBeenCalled();

    release();
    await Promise.all([closingWorker, closingTransport]);
    expect(workerClosed).toBe(true);
    expect(transportClosed).toBe(true);
    expect(mocks.disconnect).toHaveBeenCalledTimes(3);
  });
});
