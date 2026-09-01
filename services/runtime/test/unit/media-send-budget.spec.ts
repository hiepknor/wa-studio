import { describe, expect, it, vi } from 'vitest';
import { parseRuntimeConfig } from '../../src/core/config/runtime-config';
import {
  campaignImageSendMemoryWeight,
  MediaSendBudgetService,
} from '../../src/modules/media-assets/media-send-budget.service';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(next => { resolve = next; });
  return { promise, resolve };
};
const config = () => parseRuntimeConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://runtime:runtime@postgres.test:5432/runtime',
  REDIS_URL: 'redis://redis.test:6379',
  RUNTIME_API_KEY: 'runtime-key-with-at-least-32-characters',
  OPENWA_BASE_URL: 'http://openwa.test:2785',
  OPENWA_API_KEY: 'openwa-key',
  OPENWA_WEBHOOK_SECRET: 'webhook-secret-with-at-least-32-characters',
  OPENWA_ALLOWED_SESSION_IDS: '00000000-0000-4000-8000-000000000001',
});

describe('MediaSendBudgetService', () => {
  it('accounts for the raw buffer, base64, and serialized request body', () => {
    expect(campaignImageSendMemoryWeight(8_388_608)).toBe(33_554_432);
  });

  it('queues buffers whose combined weight would exceed the per-process budget', async () => {
    const budget = new MediaSendBudgetService({
      ...config(),
      CAMPAIGN_MEDIA_SEND_MEMORY_BUDGET_BYTES: 33_554_432,
    });
    const gate = deferred();
    const secondStarted = vi.fn();
    const first = budget.withBytes(24_000_000, async () => gate.promise);
    const second = budget.withBytes(24_000_000, async () => { secondStarted(); });

    await Promise.resolve();
    expect(secondStarted).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([first, second]);
    expect(secondStarted).toHaveBeenCalledOnce();
  });

  it('releases capacity when a send fails', async () => {
    const budget = new MediaSendBudgetService({
      ...config(),
      CAMPAIGN_MEDIA_SEND_MEMORY_BUDGET_BYTES: 33_554_432,
    });
    await expect(budget.withBytes(32_000_000, async () => {
      throw new Error('send failed');
    })).rejects.toThrow('send failed');
    await expect(budget.withBytes(32_000_000, async () => 'next')).resolves.toBe('next');
  });

  it('removes a queued send when its lease heartbeat loses ownership', async () => {
    const budget = new MediaSendBudgetService({
      ...config(),
      CAMPAIGN_MEDIA_SEND_MEMORY_BUDGET_BYTES: 33_554_432,
    });
    const gate = deferred();
    const first = budget.withBytes(32_000_000, async () => gate.promise);
    const operation = vi.fn();
    const waiting = budget.withBytes(32_000_000, operation, {
      onWait: vi.fn().mockRejectedValue(new Error('lease lost')),
      waitHeartbeatMs: 1,
    });

    await expect(waiting).rejects.toThrow('lease lost');
    expect(operation).not.toHaveBeenCalled();
    gate.resolve();
    await first;
  });
});
