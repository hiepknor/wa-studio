import { Module } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module';
import { WebhookRepository } from './webhook.repository';
import { RuntimeEventRepository } from './runtime-event.repository';
import { MessagesModule } from '../messages/messages.module';
import { WebhookProcessorService } from './webhook-processor.service';
import { ContactsModule } from '../contacts/contacts.module';
import { OpenWAModule } from '../../integrations/openwa/openwa.module';
import { OpenWAClient } from '../../integrations/openwa/openwa.client';
import type { RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { WebhookRegistrationReconciliationTick } from './webhook-registration-reconciliation.tick';
import { WebhookIngressService } from './webhook-ingress.service';

@Module({
  imports: [GatewayModule, MessagesModule, ContactsModule, OpenWAModule],
  providers: [
    WebhookRepository,
    RuntimeEventRepository,
    WebhookProcessorService,
    WebhookIngressService,
    {
      provide: WebhookRegistrationReconciliationTick,
      useFactory: (openwa: OpenWAClient, config: RuntimeConfig) => {
        return new WebhookRegistrationReconciliationTick(openwa, {
          enabled: config.OPENWA_WEBHOOK_RECONCILIATION_ENABLED,
          callbackUrl: config.OPENWA_WEBHOOK_CALLBACK_URL ?? null,
          secret: config.OPENWA_WEBHOOK_SECRET,
          allowedSessionIds: config.OPENWA_ALLOWED_SESSION_IDS,
        });
      },
      inject: [OpenWAClient, RUNTIME_CONFIG],
    },
  ],
  exports: [
    WebhookRepository,
    RuntimeEventRepository,
    WebhookProcessorService,
    WebhookIngressService,
    WebhookRegistrationReconciliationTick,
  ],
})
export class WebhooksModule {}
