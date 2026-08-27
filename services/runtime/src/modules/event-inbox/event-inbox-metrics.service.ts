import { Inject, Injectable } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from '@prometheus-io/client';
import { EVENT_INBOX_CONFIG } from '../../core/event-inbox/event-inbox-config.module';
import { eventInboxConfig, type EventInboxConfig } from '../../core/event-inbox/event-inbox-config';
import { EventInboxRepository } from './event-inbox.repository';

@Injectable()
export class EventInboxMetricsService {
  private readonly registry = new Registry();
  private readonly events: Gauge<'state'>;
  private readonly storedBytes: Gauge;
  private readonly maxStoredEvents: Gauge;
  private readonly maxStoredBytes: Gauge;
  private readonly oldestPendingAge: Gauge;
  private readonly devices: Gauge<'state'>;
  private readonly ownedSessions: Gauge;
  private readonly activeRateLimitBuckets: Gauge;
  private readonly blockedPairingAttempts: Gauge;
  private readonly snapshotUp: Gauge;
  private readonly snapshotFailures: Counter;
  private readonly scrapeDuration: Histogram<'result'>;
  private activeScrape: Promise<string> | undefined;

  constructor(
    private readonly repository: EventInboxRepository,
    @Inject(EVENT_INBOX_CONFIG) private readonly config: EventInboxConfig = eventInboxConfig(),
  ) {
    collectDefaultMetrics({ register: this.registry, prefix: 'wa_event_inbox_' });
    const buildInfo = new Gauge({
      name: 'wa_event_inbox_build_info',
      help: 'Static Event Inbox protocol information.',
      labelNames: ['protocol_version'] as const,
      registers: [this.registry],
    });
    buildInfo.set({ protocol_version: '2' }, 1);
    this.events = new Gauge({
      name: 'wa_event_inbox_events',
      help: 'Current Event Inbox event counts by bounded state.',
      labelNames: ['state'] as const,
      registers: [this.registry],
    });
    this.storedBytes = new Gauge({
      name: 'wa_event_inbox_storage_bytes',
      help: 'Bytes charged to the Event Inbox storage ledger.',
      registers: [this.registry],
    });
    this.maxStoredEvents = new Gauge({
      name: 'wa_event_inbox_storage_limit_events',
      help: 'Configured maximum stored Event Inbox events.',
      registers: [this.registry],
    });
    this.maxStoredBytes = new Gauge({
      name: 'wa_event_inbox_storage_limit_bytes',
      help: 'Configured maximum Event Inbox storage bytes.',
      registers: [this.registry],
    });
    this.oldestPendingAge = new Gauge({
      name: 'wa_event_inbox_oldest_pending_age_seconds',
      help: 'Age in seconds of the oldest pending Event Inbox event, or zero when empty.',
      registers: [this.registry],
    });
    this.devices = new Gauge({
      name: 'wa_event_inbox_devices',
      help: 'Current Event Inbox device counts by bounded state.',
      labelNames: ['state'] as const,
      registers: [this.registry],
    });
    this.ownedSessions = new Gauge({
      name: 'wa_event_inbox_owned_sessions',
      help: 'Current count of sessions owned by active Event Inbox devices.',
      registers: [this.registry],
    });
    this.activeRateLimitBuckets = new Gauge({
      name: 'wa_event_inbox_pair_rate_limit_buckets',
      help: 'Current active pairing rate-limit bucket count.',
      registers: [this.registry],
    });
    this.blockedPairingAttempts = new Gauge({
      name: 'wa_event_inbox_pairing_blocked_attempts',
      help: 'Pairing attempts blocked in currently active rate-limit windows.',
      registers: [this.registry],
    });
    this.snapshotUp = new Gauge({
      name: 'wa_event_inbox_metrics_snapshot_up',
      help: 'Whether the most recent Event Inbox readiness snapshot succeeded.',
      registers: [this.registry],
    });
    this.snapshotFailures = new Counter({
      name: 'wa_event_inbox_metrics_snapshot_failures_total',
      help: 'Event Inbox metric readiness snapshots that failed.',
      registers: [this.registry],
    });
    this.scrapeDuration = new Histogram({
      name: 'wa_event_inbox_metrics_scrape_duration_seconds',
      help: 'Time spent refreshing and rendering Event Inbox metrics.',
      labelNames: ['result'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });

    this.maxStoredEvents.set(config.EVENT_INBOX_MAX_STORED_EVENTS);
    this.maxStoredBytes.set(config.EVENT_INBOX_MAX_STORED_BYTES);
    this.snapshotUp.set(0);
    for (const state of ['dead', 'leased', 'pending', 'stored']) this.events.set({ state }, 0);
    for (const state of ['active', 'legacy']) this.devices.set({ state }, 0);
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  scrape(): Promise<string> {
    this.activeScrape ??= this.performScrape().finally(() => {
      this.activeScrape = undefined;
    });
    return this.activeScrape;
  }

  private async performScrape(): Promise<string> {
    const started = performance.now();
    let result: 'complete' | 'degraded' = 'complete';
    try {
      const snapshot = await this.repository.readiness();
      this.events.set({ state: 'stored' }, snapshot.storedEvents);
      this.events.set({ state: 'pending' }, snapshot.pendingEvents);
      this.events.set({ state: 'leased' }, snapshot.leasedEvents);
      this.events.set({ state: 'dead' }, snapshot.deadEvents);
      this.storedBytes.set(snapshot.storedBytes);
      this.oldestPendingAge.set(snapshot.oldestPendingAgeSeconds ?? 0);
      this.devices.set({ state: 'active' }, snapshot.activeDevices);
      this.devices.set({ state: 'legacy' }, snapshot.legacyDevices);
      this.ownedSessions.set(snapshot.ownedSessions);
      this.activeRateLimitBuckets.set(snapshot.activeRateLimitBuckets);
      this.blockedPairingAttempts.set(snapshot.rateLimitedPairingAttempts);
      this.snapshotUp.set(1);
    } catch {
      result = 'degraded';
      this.snapshotUp.set(0);
      this.snapshotFailures.inc();
    }
    try {
      return await this.registry.metrics();
    } finally {
      this.scrapeDuration.observe(
        { result },
        Math.max(0, performance.now() - started) / 1_000,
      );
    }
  }
}
