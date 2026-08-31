import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { EventInboxConfig } from '../../src/core/event-inbox/event-inbox-config';
import {
  EventInboxMetricsTokenGuard,
} from '../../src/modules/event-inbox/event-inbox-metrics.controller';
import { EventInboxMetricsService } from '../../src/modules/event-inbox/event-inbox-metrics.service';
import type { EventInboxRepository } from '../../src/modules/event-inbox/event-inbox.repository';

const token = 'event-inbox-metrics-token-with-at-least-32-characters';
const config = (metricsToken?: string): EventInboxConfig => ({
  EVENT_INBOX_MAX_STORED_BYTES: 1024 * 1024,
  EVENT_INBOX_MAX_STORED_EVENTS: 1000,
  EVENT_INBOX_METRICS_TOKEN: metricsToken,
} as EventInboxConfig);
const executionContext = (authorization?: string) => ({
  switchToHttp: () => ({
    getRequest: () => ({
      header: (name: string) => name === 'authorization' ? authorization : undefined,
    }),
  }),
});

describe('Event Inbox metrics', () => {
  it('hides an unconfigured endpoint and requires its exact bearer token', () => {
    expect(() => new EventInboxMetricsTokenGuard(config()).canActivate(
      executionContext() as never,
    )).toThrow(NotFoundException);
    const guard = new EventInboxMetricsTokenGuard(config(token));
    expect(() => guard.canActivate(executionContext(`Bearer ${token}-wrong`) as never))
      .toThrow(UnauthorizedException);
    expect(guard.canActivate(executionContext(`Bearer ${token}`) as never)).toBe(true);
  });

  it('exports bounded readiness gauges without device, session or credential values', async () => {
    const repository = {
      readiness: vi.fn().mockResolvedValue({
        storedEvents: 7,
        storedBytes: 4096,
        pendingEvents: 3,
        leasedEvents: 1,
        deadEvents: 2,
        retainedReceipts: 11,
        oldestPendingAgeSeconds: 42,
        activeDevices: 2,
        legacyDevices: 1,
        ownedSessions: 4,
        activeRateLimitBuckets: 5,
        rateLimitedPairingAttempts: 6,
        maxStoredEvents: 1000,
        maxStoredBytes: 1024 * 1024,
      }),
    };
    const metrics = new EventInboxMetricsService(
      repository as unknown as EventInboxRepository,
      config(token),
    );
    const output = await metrics.scrape();

    expect(output).toContain('wa_event_inbox_build_info{protocol_version="2"} 1');
    expect(output).toContain('wa_event_inbox_process_cpu_user_seconds_total');
    expect(output).toContain('wa_event_inbox_nodejs_version_info');
    expect(output).toContain('wa_event_inbox_events{state="pending"} 3');
    expect(output).toContain('wa_event_inbox_events{state="dead"} 2');
    expect(output).toContain('wa_event_inbox_events{state="receipts"} 11');
    expect(output).toContain('wa_event_inbox_storage_bytes 4096');
    expect(output).toContain('wa_event_inbox_storage_limit_bytes 1048576');
    expect(output).toContain('wa_event_inbox_oldest_pending_age_seconds 42');
    expect(output).toContain('wa_event_inbox_devices{state="active"} 2');
    expect(output).toContain('wa_event_inbox_pairing_blocked_attempts 6');
    expect(output).toContain('wa_event_inbox_metrics_snapshot_up 1');
    expect(output).not.toContain(token);
  });

  it('keeps a degraded scrape available and coalesces concurrent database snapshots', async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const repository = {
      readiness: vi.fn().mockImplementation(() => waiting.then(() => {
        throw new Error('database unavailable');
      })),
    };
    const metrics = new EventInboxMetricsService(
      repository as unknown as EventInboxRepository,
      config(token),
    );
    const first = metrics.scrape();
    const second = metrics.scrape();
    release();
    const [firstOutput, secondOutput] = await Promise.all([first, second]);

    expect(firstOutput).toBe(secondOutput);
    expect(repository.readiness).toHaveBeenCalledTimes(1);
    expect(firstOutput).toContain('wa_event_inbox_metrics_snapshot_up 0');
    expect(firstOutput).toContain('wa_event_inbox_metrics_snapshot_failures_total 1');
  });
});
