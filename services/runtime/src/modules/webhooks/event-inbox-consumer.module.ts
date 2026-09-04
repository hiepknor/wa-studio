import { Module } from '@nestjs/common';
import { RuntimeDispatchReadinessModule } from '../../core/dispatch-readiness/runtime-dispatch-readiness.module';
import { EventInboxConsumerService } from './event-inbox-consumer.service';
import { WebhooksModule } from './webhooks.module';

@Module({
  imports: [WebhooksModule, RuntimeDispatchReadinessModule],
  providers: [EventInboxConsumerService],
})
export class EventInboxConsumerModule {}
