import { Inject, Injectable } from '@nestjs/common';
import {
  eventInboxConnectorBindingSchema,
  eventInboxConnectorStatusResponseSchema,
  type EventInboxConnectorStatusResponse,
} from '../../contracts/event-inbox';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { readBoundedResponseJson } from '../../core/http/bounded-response';

const maximumControlResponseBytes = 1024 * 1024;

export type EventInboxConnectorStatusSnapshot = EventInboxConnectorStatusResponse & {
  receivedAt: Date;
  requestDurationMs: number;
};

@Injectable()
export class EventInboxConnectorClient {
  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async setBinding(input: {
    sessionId: string;
    connectorId: string;
    webhookId: string;
    generation: number;
  }): Promise<{ webhookId: string; generation: number }> {
    const response = await this.request(
      'PUT',
      `/api/v1/event-inbox/connectors/bindings/${encodeURIComponent(input.sessionId)}`,
      {
        connectorId: input.connectorId,
        webhookId: input.webhookId,
        generation: input.generation,
      },
    );
    const parsed = eventInboxConnectorBindingSchema.safeParse(response);
    if (!parsed.success) throw new Error('Event Inbox returned an invalid connector binding');
    return parsed.data;
  }

  async status(): Promise<EventInboxConnectorStatusSnapshot> {
    const startedAt = Date.now();
    const response = await this.request('GET', '/api/v1/event-inbox/connectors/status');
    const parsed = eventInboxConnectorStatusResponseSchema.safeParse(response);
    if (!parsed.success) throw new Error('Event Inbox returned an invalid connector status');
    const receivedAt = new Date();
    return {
      ...parsed.data,
      receivedAt,
      requestDurationMs: receivedAt.valueOf() - startedAt,
    };
  }

  private async request(method: 'GET' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    if (!this.config.EVENT_INBOX_BASE_URL || !this.config.EVENT_INBOX_DEVICE_TOKEN) {
      throw new Error('Event Inbox connector control plane is not configured');
    }
    const response = await fetch(new URL(path, this.config.EVENT_INBOX_BASE_URL), {
      method,
      headers: {
        authorization: `Bearer ${this.config.EVENT_INBOX_DEVICE_TOKEN}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(this.config.EVENT_INBOX_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Event Inbox connector request returned HTTP ${response.status}`);
    }
    return readBoundedResponseJson(response, maximumControlResponseBytes);
  }
}
