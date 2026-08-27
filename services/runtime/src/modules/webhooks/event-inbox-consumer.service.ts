import { HttpException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import {
  eventInboxClaimResponseSchema,
  type EventInboxNack,
} from '../../contracts/event-inbox';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { readBoundedResponseJson } from '../../core/http/bounded-response';
import type { OpenWAWebhookEnvelope } from './webhook.repository';
import { WebhookIngressService } from './webhook-ingress.service';

class PoisonEventError extends Error {}

const maximumMutationResponseBytes = 1024 * 1024;

@Injectable()
export class EventInboxConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventInboxConsumerService.name);
  private readonly abort = new AbortController();
  private loopPromise: Promise<void> | undefined;

  constructor(
    private readonly ingress: WebhookIngressService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  onModuleInit(): void {
    if (this.config.EVENT_INBOX_BASE_URL) this.loopPromise = this.runLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.abort.abort();
    await this.loopPromise;
  }

  private async runLoop(): Promise<void> {
    let backoffMs = this.config.EVENT_INBOX_POLL_INTERVAL_MS;
    while (!this.abort.signal.aborted) {
      try {
        const count = await this.runOnce();
        backoffMs = this.config.EVENT_INBOX_POLL_INTERVAL_MS;
        if (count === 0) await this.wait(backoffMs);
      } catch (error) {
        if (this.abort.signal.aborted) return;
        this.logger.warn({ event: 'event_inbox.claim.failed', error });
        await this.wait(backoffMs);
        backoffMs = Math.min(30_000, backoffMs * 2);
      }
    }
  }

  async runOnce(): Promise<number> {
    const baseUrl = this.config.EVENT_INBOX_BASE_URL!;
    const token = this.config.EVENT_INBOX_DEVICE_TOKEN!;
    const response = await this.request(baseUrl, token, '/api/v1/event-inbox/events/claim', {
      limit: this.config.EVENT_INBOX_BATCH_SIZE,
      waitSeconds: 20,
    });
    const parsed = eventInboxClaimResponseSchema.safeParse(response);
    if (!parsed.success) throw new Error('Event Inbox returned an invalid claim response');

    const receiptHandles: string[] = [];
    const rejected: EventInboxNack[] = [];
    for (const event of parsed.data.data) {
      try {
        const rawBody = Buffer.from(event.rawBody, 'base64');
        let envelope: Partial<OpenWAWebhookEnvelope>;
        try {
          envelope = JSON.parse(rawBody.toString('utf8')) as Partial<OpenWAWebhookEnvelope>;
        } catch {
          throw new PoisonEventError('Event Inbox payload is not valid JSON');
        }
        if (envelope.idempotencyKey !== event.idempotencyKey) {
          throw new PoisonEventError('Event Inbox idempotency key does not match its raw envelope');
        }
        await this.ingress.accept(rawBody, event.signature, envelope);
        receiptHandles.push(event.receiptHandle);
      } catch (error) {
        const disposition = this.disposition(error);
        rejected.push({
          receiptHandle: event.receiptHandle,
          disposition,
          reason: disposition === 'dead' ? this.deadReason(error) : 'runtime_ingress_unavailable',
        });
        this.logger.error({
          event: 'event_inbox.event.rejected',
          webhookIdempotencyKey: event.idempotencyKey,
          disposition,
          error,
        });
      }
    }
    if (receiptHandles.length > 0) {
      await this.request(baseUrl, token, '/api/v1/event-inbox/events/ack', { receiptHandles });
    }
    if (rejected.length > 0) {
      await this.request(baseUrl, token, '/api/v1/event-inbox/events/nack', { items: rejected });
    }
    return parsed.data.data.length;
  }

  private disposition(error: unknown): 'retry' | 'dead' {
    if (error instanceof PoisonEventError) return 'dead';
    if (error instanceof HttpException && [400, 403, 422].includes(error.getStatus())) return 'dead';
    return 'retry';
  }

  private deadReason(error: unknown): string {
    if (error instanceof PoisonEventError) return 'invalid_event_payload';
    if (error instanceof HttpException && error.getStatus() === 403) return 'session_not_allowed';
    return 'invalid_openwa_envelope';
  }

  private async request(
    baseUrl: string,
    token: string,
    path: string,
    body: unknown,
  ): Promise<unknown> {
    const response = await fetch(new URL(path, baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.any([
        this.abort.signal,
        AbortSignal.timeout(this.config.EVENT_INBOX_REQUEST_TIMEOUT_MS),
      ]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Event Inbox request returned HTTP ${response.status}`);
    }
    return readBoundedResponseJson(
      response,
      path.endsWith('/claim')
        ? this.config.EVENT_INBOX_RESPONSE_MAX_BYTES
        : maximumMutationResponseBytes,
    );
  }

  private async wait(milliseconds: number): Promise<void> {
    try {
      await delay(milliseconds, undefined, { signal: this.abort.signal });
    } catch (error) {
      if (!this.abort.signal.aborted) throw error;
    }
  }
}
