import { Module } from '@nestjs/common';
import { OpenWAModule } from '../../integrations/openwa/openwa.module';
import { GatewayModule } from '../gateway/gateway.module';
import { MediaAssetsModule } from '../media-assets/media-assets.module';
import { MessageJobController } from './message-job.controller';
import { MessageJobProcessorService } from './message-job-processor.service';
import { MessageJobRepository } from './message-job.repository';
import { MessageJobService } from './message-job.service';
import { MessageSendPolicyService } from './message-send-policy.service';
import { OutboundSessionLeaseRepository } from './outbound-session-lease.repository';
import { OutboundSessionLeaseService } from './outbound-session-lease.service';
import { MessageStatusProjectionService } from './message-status-projection.service';

@Module({
  imports: [GatewayModule, MediaAssetsModule, OpenWAModule],
  controllers: [MessageJobController],
  providers: [
    MessageJobRepository,
    MessageJobService,
    MessageSendPolicyService,
    MessageJobProcessorService,
    OutboundSessionLeaseRepository,
    OutboundSessionLeaseService,
    MessageStatusProjectionService,
  ],
  exports: [
    MessageJobRepository,
    MessageSendPolicyService,
    MessageJobProcessorService,
    MessageStatusProjectionService,
  ],
})
export class MessagesModule {}
