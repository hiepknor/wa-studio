import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../../src/core/config/runtime-config';
import type { MessageJobRepository } from '../../src/modules/messages/message-job.repository';
import type { OutboundSessionLeaseRepository } from '../../src/modules/messages/outbound-session-lease.repository';
import { OutboundSessionLeaseService } from '../../src/modules/messages/outbound-session-lease.service';

describe('OutboundSessionLeaseService', () => {
  it('fences the send with leases longer than the configured OpenWA request timeout', async () => {
    const leases = {
      release: vi.fn().mockResolvedValue(true),
      renew: vi.fn().mockResolvedValue(true),
      tryAcquire: vi.fn().mockResolvedValue(true),
    } as unknown as OutboundSessionLeaseRepository;
    const messages = {
      refreshProcessingLease: vi.fn().mockResolvedValue(true),
    } as unknown as MessageJobRepository;
    const service = new OutboundSessionLeaseService(
      leases,
      messages,
      {
        OPENWA_REQUEST_TIMEOUT_MS: 120_000,
        OUTBOUND_MAX_DELAY_MS: 60_000,
      } as RuntimeConfig,
    );

    await service.withLease('session-id', '00000000-0000-4000-8000-000000000001', async verifyForSend => {
      await verifyForSend();
    });

    expect(leases.tryAcquire).toHaveBeenCalledWith(
      'session-id',
      '00000000-0000-4000-8000-000000000001',
      expect.any(String),
      105_000,
    );
    expect(leases.renew).toHaveBeenCalledWith(
      'session-id',
      '00000000-0000-4000-8000-000000000001',
      expect.any(String),
      135_000,
    );
    expect(messages.refreshProcessingLease).toHaveBeenNthCalledWith(
      2,
      '00000000-0000-4000-8000-000000000001',
      135_000,
    );
    expect(leases.release).toHaveBeenCalledOnce();
  });
});
