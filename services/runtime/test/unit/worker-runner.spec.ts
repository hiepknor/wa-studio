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
});
