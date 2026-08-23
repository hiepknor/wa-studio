import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EVENT_INBOX_CONFIG } from '../../core/event-inbox/event-inbox-config.module';
import { eventInboxConfig, type EventInboxConfig } from '../../core/event-inbox/event-inbox-config';
import { EventInboxDeviceRepository } from './event-inbox-device.repository';
import { EventInboxRepository } from './event-inbox.repository';

@Injectable()
export class EventInboxMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventInboxMaintenanceService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly repository: EventInboxRepository,
    private readonly devices: EventInboxDeviceRepository,
    @Inject(EVENT_INBOX_CONFIG) private readonly config: EventInboxConfig = eventInboxConfig(),
  ) {}

  onModuleInit(): void {
    void this.cleanup();
    this.timer = setInterval(() => void this.cleanup(), this.config.EVENT_INBOX_CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async cleanup(): Promise<void> {
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
      const inactive = await this.devices.cleanupInactive();
      if (inactive.sessionFences > 0 || inactive.devices > 0) {
        this.logger.log({ event: 'event_inbox.inactive_devices.deleted', ...inactive });
      }
    } catch (error) {
      this.logger.error({ event: 'event_inbox.expiry_cleanup.failed', error });
    }
  }
}
