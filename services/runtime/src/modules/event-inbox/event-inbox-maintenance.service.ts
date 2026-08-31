import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EVENT_INBOX_CONFIG } from '../../core/event-inbox/event-inbox-config.module';
import { eventInboxConfig, type EventInboxConfig } from '../../core/event-inbox/event-inbox-config';
import { EventInboxDeviceRepository } from './event-inbox-device.repository';
import { EventInboxRepository } from './event-inbox.repository';
import { EventInboxMediaRepository } from './event-inbox-media.repository';

@Injectable()
export class EventInboxMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventInboxMaintenanceService.name);
  private activeCleanup: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly repository: EventInboxRepository,
    private readonly devices: EventInboxDeviceRepository,
    private readonly media: EventInboxMediaRepository,
    @Inject(EVENT_INBOX_CONFIG) private readonly config: EventInboxConfig = eventInboxConfig(),
  ) {}

  onModuleInit(): void {
    void this.cleanup();
    this.timer = setInterval(() => void this.cleanup(), this.config.EVENT_INBOX_CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.activeCleanup;
  }

  private cleanup(): Promise<void> {
    if (this.activeCleanup) return this.activeCleanup;
    const active = this.runCleanup().finally(() => {
      if (this.activeCleanup === active) this.activeCleanup = undefined;
    });
    this.activeCleanup = active;
    return active;
  }

  private async runCleanup(): Promise<void> {
    try {
      let deleted = 0;
      let batches = 0;
      while (batches < this.config.EVENT_INBOX_CLEANUP_MAX_BATCHES) {
        const batch = await this.repository.removeExpired(this.config.EVENT_INBOX_CLEANUP_BATCH_SIZE);
        deleted += batch;
        batches += 1;
        if (batch < this.config.EVENT_INBOX_CLEANUP_BATCH_SIZE) break;
      }
      if (deleted > 0) {
        this.logger.log({ event: 'event_inbox.expired_events.deleted', deleted });
      }
      let expiredRateLimits = 0;
      let rateLimitBatches = 0;
      while (rateLimitBatches < this.config.EVENT_INBOX_CLEANUP_MAX_BATCHES) {
        const batch = await this.repository.removeExpiredRateLimits(
          this.config.EVENT_INBOX_CLEANUP_BATCH_SIZE,
        );
        expiredRateLimits += batch;
        rateLimitBatches += 1;
        if (batch < this.config.EVENT_INBOX_CLEANUP_BATCH_SIZE) break;
      }
      if (expiredRateLimits > 0) {
        this.logger.log({
          event: 'event_inbox.expired_rate_limits.deleted',
          deleted: expiredRateLimits,
        });
      }
      let expiredReceipts = 0;
      let receiptBatches = 0;
      while (receiptBatches < this.config.EVENT_INBOX_CLEANUP_MAX_BATCHES) {
        const batch = await this.repository.removeExpiredReceipts(
          this.config.EVENT_INBOX_CLEANUP_BATCH_SIZE,
        );
        expiredReceipts += batch;
        receiptBatches += 1;
        if (batch < this.config.EVENT_INBOX_CLEANUP_BATCH_SIZE) break;
      }
      if (expiredReceipts > 0) {
        this.logger.log({
          event: 'event_inbox.expired_receipts.deleted',
          deleted: expiredReceipts,
        });
      }
      let expiredMediaLeases = 0;
      let orphanedMediaBlobs = 0;
      let mediaBatches = 0;
      while (mediaBatches < this.config.EVENT_INBOX_CLEANUP_MAX_BATCHES) {
        const batch = await this.media.removeExpired(this.config.EVENT_INBOX_CLEANUP_BATCH_SIZE);
        expiredMediaLeases += batch.leases;
        orphanedMediaBlobs += batch.blobs;
        mediaBatches += 1;
        if (batch.leases < this.config.EVENT_INBOX_CLEANUP_BATCH_SIZE) break;
      }
      if (expiredMediaLeases > 0 || orphanedMediaBlobs > 0) {
        this.logger.log({
          event: 'event_inbox.expired_media.deleted',
          leases: expiredMediaLeases,
          blobs: orphanedMediaBlobs,
        });
      }
      const inactive = await this.devices.cleanupInactive();
      if (inactive.sessionFences > 0 || inactive.devices > 0) {
        this.logger.log({ event: 'event_inbox.inactive_devices.deleted', ...inactive });
      }
    } catch (error) {
      this.logger.error({ event: 'event_inbox.expiry_cleanup.failed', error });
    }
  }
}
