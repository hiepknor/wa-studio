import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventInboxConfig } from '../../src/core/event-inbox/event-inbox-config';
import type { EventInboxDeviceRepository } from '../../src/modules/event-inbox/event-inbox-device.repository';
import { EventInboxMaintenanceService } from '../../src/modules/event-inbox/event-inbox-maintenance.service';
import type { EventInboxRepository } from '../../src/modules/event-inbox/event-inbox.repository';
import type { EventInboxMediaRepository } from '../../src/modules/event-inbox/event-inbox-media.repository';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

const config = {
  EVENT_INBOX_CLEANUP_BATCH_SIZE: 100,
  EVENT_INBOX_CLEANUP_INTERVAL_MS: 1_000,
  EVENT_INBOX_CLEANUP_MAX_BATCHES: 2,
} as EventInboxConfig;

afterEach(() => vi.useRealTimers());

describe('EventInboxMaintenanceService', () => {
  it('prevents overlapping cleanup and drains active work during shutdown', async () => {
    vi.useFakeTimers();
    const firstBatch = deferred<number>();
    const repository = {
      removeExpired: vi.fn().mockReturnValue(firstBatch.promise),
      removeExpiredRateLimits: vi.fn().mockResolvedValue(0),
      removeExpiredReceipts: vi.fn().mockResolvedValue(0),
    } as unknown as EventInboxRepository;
    const devices = {
      cleanupInactive: vi.fn().mockResolvedValue({ devices: 0, sessionFences: 0 }),
    } as unknown as EventInboxDeviceRepository;
    const media = {
      removeExpired: vi.fn().mockResolvedValue({ leases: 0, blobs: 0 }),
    } as unknown as EventInboxMediaRepository;
    const service = new EventInboxMaintenanceService(repository, devices, media, config);

    service.onModuleInit();
    expect(repository.removeExpired).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(repository.removeExpired).toHaveBeenCalledOnce();

    let shutdownCompleted = false;
    const shutdown = service.onModuleDestroy().then(() => { shutdownCompleted = true; });
    await Promise.resolve();
    expect(shutdownCompleted).toBe(false);

    firstBatch.resolve(0);
    await shutdown;
    expect(repository.removeExpiredRateLimits).toHaveBeenCalledOnce();
    expect(repository.removeExpiredReceipts).toHaveBeenCalledOnce();
    expect(media.removeExpired).toHaveBeenCalledOnce();
    expect(devices.cleanupInactive).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(repository.removeExpired).toHaveBeenCalledOnce();
  });
});
