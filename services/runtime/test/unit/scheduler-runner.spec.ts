import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../../src/core/config/runtime-config';
import { SchedulerRunnerService } from '../../src/modules/orchestration/scheduler-runner.service';

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
};

describe('SchedulerRunnerService', () => {
  it('releases leadership when campaign startup reconciliation fails', async () => {
    const startupError = new Error('database unavailable');
    const resolvedTick = { run: vi.fn().mockResolvedValue(undefined) };
    const leadership = {
      acquire: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
      waitForLoss: vi.fn(),
    };
    const runner = new SchedulerRunnerService(
      resolvedTick as never,
      resolvedTick as never,
      resolvedTick as never,
      { beginSchedulerSession: vi.fn().mockRejectedValue(startupError), run: vi.fn() } as never,
      resolvedTick as never,
      resolvedTick as never,
      { publishHeartbeat: vi.fn(), publishSchedulerTickState: vi.fn() } as never,
      { start: vi.fn(), stop: vi.fn() } as never,
      resolvedTick as never,
      resolvedTick as never,
      resolvedTick as never,
      resolvedTick as never,
      resolvedTick as never,
      resolvedTick as never,
      leadership as never,
      {
        GATEWAY_SYNC_POLL_INTERVAL_MS: 30_000,
        RUNTIME_RETENTION_INTERVAL_MS: 60_000,
        OPENWA_WEBHOOK_RECONCILIATION_INTERVAL_MS: 60_000,
      } as RuntimeConfig,
    );

    await expect(runner.start()).rejects.toBe(startupError);
    expect(leadership.release).toHaveBeenCalledOnce();
  });

  it('retains leadership when a tick exceeds the shutdown grace period', async () => {
    vi.useFakeTimers();
    try {
      const messageWork = deferred<void>();
      const resolvedTick = { run: vi.fn().mockResolvedValue(undefined) };
      const campaignTick = {
        beginSchedulerSession: vi.fn().mockResolvedValue(undefined),
        run: vi.fn().mockResolvedValue(undefined),
      };
      const queues = {
        publishHeartbeat: vi.fn().mockResolvedValue(undefined),
        publishSchedulerTickState: vi.fn().mockResolvedValue(undefined),
      };
      const gatewayListener = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      };
      const leadership = {
        acquire: vi.fn().mockResolvedValue(undefined),
        release: vi.fn().mockResolvedValue(undefined),
        waitForLoss: vi.fn().mockReturnValue(new Promise<Error>(() => undefined)),
      };
      const runner = new SchedulerRunnerService(
        { run: vi.fn(() => messageWork.promise) } as never,
        resolvedTick as never,
        resolvedTick as never,
        campaignTick as never,
        resolvedTick as never,
        resolvedTick as never,
        queues as never,
        gatewayListener as never,
        resolvedTick as never,
        resolvedTick as never,
        resolvedTick as never,
        resolvedTick as never,
        resolvedTick as never,
        resolvedTick as never,
        leadership as never,
        {
          GATEWAY_SYNC_POLL_INTERVAL_MS: 30_000,
          RUNTIME_RETENTION_INTERVAL_MS: 60_000,
          OPENWA_WEBHOOK_RECONCILIATION_INTERVAL_MS: 60_000,
        } as RuntimeConfig,
      );

      await runner.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(campaignTick.beginSchedulerSession).toHaveBeenCalledOnce();

      let stopped = false;
      const stopping = runner.stop().then(() => { stopped = true; });
      await vi.advanceTimersByTimeAsync(10_001);

      expect(stopped).toBe(false);
      expect(leadership.release).not.toHaveBeenCalled();

      messageWork.resolve();
      await stopping;
      expect(leadership.release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
