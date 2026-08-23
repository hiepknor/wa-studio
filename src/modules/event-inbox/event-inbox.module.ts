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
import { EventInboxRepository } from './event-inbox.repository';

@Module({
  imports: [EventInboxConfigModule],
  controllers: [EventInboxIngressController, EventInboxController, EventInboxHealthController],
  providers: [
    EventInboxRepository,
    EventInboxMaintenanceService,
    EventInboxTokenService,
    EventInboxOpenWAClient,
  ],
})
export class EventInboxModule {}
