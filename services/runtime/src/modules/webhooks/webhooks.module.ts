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
import { EventInboxConnectorClient } from './event-inbox-connector.client';
import { OpenWAConnectorHealthRepository } from './openwa-connector-health.repository';
import { EventInboxConnectorHealthTick } from './event-inbox-connector-health.tick';

@Module({
  imports: [GatewayModule, MessagesModule, ContactsModule, OpenWAModule],
  providers: [
    WebhookRepository,
    RuntimeEventRepository,
    WebhookProcessorService,
    WebhookIngressService,
    EventInboxConnectorClient,
    OpenWAConnectorHealthRepository,
    EventInboxConnectorHealthTick,
    {
      provide: WebhookRegistrationReconciliationTick,
      useFactory: (
        openwa: OpenWAClient,
        config: RuntimeConfig,
        connector: EventInboxConnectorClient,
        connectorHealth: OpenWAConnectorHealthRepository,
      ) => {
        return new WebhookRegistrationReconciliationTick(openwa, {
          enabled: config.OPENWA_WEBHOOK_RECONCILIATION_ENABLED,
          callbackUrl: config.OPENWA_WEBHOOK_CALLBACK_URL ?? null,
          secret: config.OPENWA_WEBHOOK_SECRET,
          allowedSessionIds: config.OPENWA_ALLOWED_SESSION_IDS,
          expectedConnectorId: config.OPENWA_CONNECTOR_ID ?? null,
          expectedPluginVersion: config.OPENWA_CONNECTOR_PLUGIN_VERSION ?? null,
          includeInboundMessages: config.OPENWA_INBOUND_MESSAGE_EVENTS_ENABLED,
        }, config.EVENT_INBOX_BASE_URL && config.OPENWA_CONNECTOR_ID ? connector : undefined,
        config.EVENT_INBOX_BASE_URL && config.OPENWA_CONNECTOR_ID ? connectorHealth : undefined);
      },
      inject: [OpenWAClient, RUNTIME_CONFIG, EventInboxConnectorClient, OpenWAConnectorHealthRepository],
    },
  ],
  exports: [
    WebhookRepository,
    RuntimeEventRepository,
    WebhookProcessorService,
    WebhookIngressService,
    WebhookRegistrationReconciliationTick,
    EventInboxConnectorHealthTick,
    OpenWAConnectorHealthRepository,
  ],
})
export class WebhooksModule {}
