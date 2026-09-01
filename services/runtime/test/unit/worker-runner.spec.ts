import { describe, expect, it, vi } from 'vitest';
import {
  CAMPAIGN_QUEUE,
  GATEWAY_SYNC_QUEUE,
  MESSAGE_SEND_QUEUE,
  WEBHOOK_QUEUE,
} from '../../src/core/queue/queue.constants';

const workerRecords = [] as Array<{
  name: string;
  concurrency: number;
  close: ReturnType<typeof vi.fn>;
}>;

vi.mock('../../src/core/config/runtime-config', () => ({
  runtimeConfig: () => ({
    REDIS_URL: 'redis://redis.test:6379',
    MESSAGE_WORKER_CONCURRENCY: 3,
    WEBHOOK_WORKER_CONCURRENCY: 11,
    GATEWAY_WORKER_CONCURRENCY: 4,
    CAMPAIGN_WORKER_CONCURRENCY: 5,
  }),
}));

import { WorkerRunnerService } from '../../src/modules/orchestration/worker-runner.service';

describe('WorkerRunnerService', () => {
  it('uses the validated per-queue concurrency configuration', async () => {
    workerRecords.length = 0;
    const queues = {
      publishHeartbeat: vi.fn().mockResolvedValue(undefined),
      startWorker: vi.fn((name: string, concurrency: number) => {
        const close = vi.fn().mockResolvedValue(undefined);
        workerRecords.push({ name, concurrency, close });
        return { close };
      }),
    };
    const processor = { process: vi.fn() };
    const runner = new WorkerRunnerService(
      processor as never,
      processor as never,
      processor as never,
      processor as never,
      queues as never,
    );

    const running = runner.run();
    await vi.waitFor(() => expect(queues.publishHeartbeat).toHaveBeenCalledWith('worker'));
    await new Promise<void>(resolve => setImmediate(resolve));
    process.emit('SIGTERM');
    await running;

    expect(workerRecords.map(worker => [worker.name, worker.concurrency])).toEqual([
      [MESSAGE_SEND_QUEUE, 3],
      [WEBHOOK_QUEUE, 11],
      [GATEWAY_SYNC_QUEUE, 4],
      [CAMPAIGN_QUEUE, 5],
    ]);
    expect(workerRecords.every(worker => worker.close.mock.calls.length === 1)).toBe(true);
  });

  it('attempts every worker close and retains multiple shutdown failures', async () => {
    const failures = [new Error('first close failed'), new Error('third close failed')];
    let workerIndex = 0;
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    const queues = {
      publishHeartbeat: vi.fn().mockResolvedValue(undefined),
      startWorker: vi.fn(() => {
        const index = workerIndex;
        workerIndex += 1;
        const close = vi.fn(index === 0
          ? () => Promise.reject(failures[0])
          : index === 2
            ? () => Promise.reject(failures[1])
            : () => Promise.resolve());
        closes.push(close);
        return { close };
      }),
    };
    const processor = { process: vi.fn() };
    const runner = new WorkerRunnerService(
      processor as never,
      processor as never,
      processor as never,
      processor as never,
      queues as never,
    );
    await runner.start();

    const failure = await runner.stop().catch(error => error) as AggregateError;

    expect(closes.every(close => close.mock.calls.length === 1)).toBe(true);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual(failures);
  });

  it('closes workers already created when a later queue fails to start', async () => {
    const startupFailure = new Error('webhook worker failed to start');
    const firstClose = vi.fn().mockResolvedValue(undefined);
    const queues = {
      publishHeartbeat: vi.fn().mockResolvedValue(undefined),
      startWorker: vi.fn()
        .mockReturnValueOnce({ close: firstClose })
        .mockImplementationOnce(() => { throw startupFailure; }),
    };
    const processor = { process: vi.fn() };
    const runner = new WorkerRunnerService(
      processor as never,
      processor as never,
      processor as never,
      processor as never,
      queues as never,
    );

    await expect(runner.start()).rejects.toBe(startupFailure);

    expect(queues.startWorker).toHaveBeenCalledTimes(2);
    expect(firstClose).toHaveBeenCalledOnce();
    await runner.stop();
    expect(firstClose).toHaveBeenCalledOnce();
  });

  it('retains both startup and rollback failures', async () => {
    const startupFailure = new Error('gateway worker failed to start');
    const rollbackFailure = new Error('message worker failed to close');
    const firstClose = vi.fn().mockRejectedValue(rollbackFailure);
    const secondClose = vi.fn().mockResolvedValue(undefined);
    const queues = {
      publishHeartbeat: vi.fn().mockResolvedValue(undefined),
      startWorker: vi.fn()
        .mockReturnValueOnce({ close: firstClose })
        .mockReturnValueOnce({ close: secondClose })
        .mockImplementationOnce(() => { throw startupFailure; }),
    };
    const processor = { process: vi.fn() };
    const runner = new WorkerRunnerService(
      processor as never,
      processor as never,
      processor as never,
      processor as never,
      queues as never,
    );

    const failure = await runner.start().catch(error => error) as AggregateError;

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual([startupFailure, rollbackFailure]);
    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondClose).toHaveBeenCalledOnce();
  });
});
