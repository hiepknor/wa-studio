import { Injectable, Logger } from '@nestjs/common';
import { EventInboxConnectorClient } from './event-inbox-connector.client';
import { OpenWAConnectorHealthRepository } from './openwa-connector-health.repository';

@Injectable()
export class EventInboxConnectorHealthTick {
  private readonly logger = new Logger(EventInboxConnectorHealthTick.name);

  constructor(
    private readonly client: EventInboxConnectorClient,
    private readonly repository: OpenWAConnectorHealthRepository,
  ) {}

  async run(): Promise<void> {
    try {
      await this.repository.applyStatus(await this.client.status());
    } catch (error) {
      await this.repository.recordPollFailure(error);
      this.logger.warn({ event: 'event_inbox.connector_health.failed', error });
      throw error;
    }
  }
}
