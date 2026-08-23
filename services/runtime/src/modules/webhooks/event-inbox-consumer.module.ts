import { Module } from '@nestjs/common';
import { EventInboxConsumerService } from './event-inbox-consumer.service';
import { WebhooksModule } from './webhooks.module';

@Module({
  imports: [WebhooksModule],
  providers: [EventInboxConsumerService],
})
export class EventInboxConsumerModule {}
