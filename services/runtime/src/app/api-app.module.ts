import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { RuntimeApiKeyGuard } from '../core/auth/runtime-api-key.guard';
import { DatabaseModule } from '../core/database/database.module';
import { QueueModule } from '../core/queue/queue.module';
import { RequestContextMiddleware } from '../core/observability/request-context.middleware';
import { RuntimeObservabilityModule } from '../core/observability/runtime-observability.module';
import { RuntimeHttpExceptionFilter } from '../core/http/runtime-http-exception.filter';
import { RuntimeConfigModule } from '../core/config/runtime-config.module';
import { OpenWAModule } from '../integrations/openwa/openwa.module';
import { CampaignsModule } from '../modules/campaigns/campaigns.module';
import { GatewayModule } from '../modules/gateway/gateway.module';
import { GroupListsModule } from '../modules/group-lists/group-lists.module';
import { HealthModule } from '../modules/health/health.module';
import { InboxModule } from '../modules/inbox/inbox.module';
import { MessagesModule } from '../modules/messages/messages.module';
import { WebhooksModule } from '../modules/webhooks/webhooks.module';
import { EventInboxConsumerModule } from '../modules/webhooks/event-inbox-consumer.module';
import { ActivityModule } from '../modules/activity/activity.module';
import { MediaAssetsModule } from '../modules/media-assets/media-assets.module';
import { StateRevisionsModule } from '../modules/state-revisions/state-revisions.module';
import { OpenWASafetyModule } from '../modules/openwa-safety/openwa-safety.module';

@Module({
  imports: [
    RuntimeConfigModule,
    DatabaseModule,
    QueueModule,
    RuntimeObservabilityModule,
    OpenWAModule,
    OpenWASafetyModule,
    GatewayModule,
    GroupListsModule,
    CampaignsModule,
    HealthModule,
    InboxModule,
    MessagesModule,
    WebhooksModule,
    EventInboxConsumerModule,
    ActivityModule,
    MediaAssetsModule,
    StateRevisionsModule,
  ],
  providers: [
    RequestContextMiddleware,
    { provide: APP_GUARD, useClass: RuntimeApiKeyGuard },
    { provide: APP_FILTER, useClass: RuntimeHttpExceptionFilter },
  ],
})
export class ApiAppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('{*splat}');
  }
}
