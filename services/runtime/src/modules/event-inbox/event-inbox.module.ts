import { Module } from '@nestjs/common';
import { EventInboxConfigModule } from '../../core/event-inbox/event-inbox-config.module';
import { EventInboxTokenService } from '../../core/event-inbox/event-inbox-token.service';
import { EventInboxOpenWAClient } from '../../integrations/openwa/event-inbox-openwa.client';
import {
  EventInboxController,
  EventInboxHealthController,
  EventInboxIngressController,
} from './event-inbox.controller';
import { EventInboxMaintenanceService } from './event-inbox-maintenance.service';
import { EventInboxDeviceRepository } from './event-inbox-device.repository';
import { EventInboxRepository } from './event-inbox.repository';
import { EventInboxPairRateLimitService } from './event-inbox-rate-limit.service';
import {
  EventInboxMetricsController,
  EventInboxMetricsTokenGuard,
} from './event-inbox-metrics.controller';
import { EventInboxMetricsService } from './event-inbox-metrics.service';
import { EventInboxConnectorController } from './event-inbox-connector.controller';
import { EventInboxConnectorRepository } from './event-inbox-connector.repository';
import {
  EventInboxMediaDownloadController,
  EventInboxMediaUploadController,
} from './event-inbox-media.controller';
import { EventInboxMediaRepository } from './event-inbox-media.repository';

@Module({
  imports: [EventInboxConfigModule],
  controllers: [
    EventInboxIngressController,
    EventInboxController,
    EventInboxHealthController,
    EventInboxMetricsController,
    EventInboxConnectorController,
    EventInboxMediaUploadController,
    EventInboxMediaDownloadController,
  ],
  providers: [
    EventInboxRepository,
    EventInboxPairRateLimitService,
    EventInboxMetricsService,
    EventInboxMetricsTokenGuard,
    EventInboxDeviceRepository,
    EventInboxMaintenanceService,
    EventInboxTokenService,
    EventInboxOpenWAClient,
    EventInboxConnectorRepository,
    EventInboxMediaRepository,
  ],
})
export class EventInboxModule {}
