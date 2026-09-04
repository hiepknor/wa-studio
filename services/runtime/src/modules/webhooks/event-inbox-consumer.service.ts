import { HttpException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import {
  eventInboxClaimResponseSchema,
  eventInboxRecoveryResponseSchema,
  type EventInboxNack,
} from '../../contracts/event-inbox';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { RuntimeDispatchReadinessService } from '../../core/dispatch-readiness/runtime-dispatch-readiness.service';
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
    @Optional() private readonly dispatchReadiness?: RuntimeDispatchReadinessService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.EVENT_INBOX_BASE_URL) return;
    if (!this.dispatchReadiness) {
      throw new Error('Event Inbox dispatch readiness service is unavailable');
    }
    await this.dispatchReadiness.beginRecovery();
    this.loopPromise = this.runLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.abort.abort();
    await this.loopPromise;
  }

  private async runLoop(): Promise<void> {
    let backoffMs = this.config.EVENT_INBOX_POLL_INTERVAL_MS;
    let recovered = false;
    while (!this.abort.signal.aborted) {
      try {
        if (!recovered) {
          await this.recover();
          recovered = true;
        }
        await this.dispatchReadiness?.refreshHeartbeat();
        const count = await this.runOnce();
        await this.dispatchReadiness?.refreshHeartbeat();
        backoffMs = this.config.EVENT_INBOX_POLL_INTERVAL_MS;
        if (count === 0) await this.wait(backoffMs);
      } catch (error) {
        if (this.abort.signal.aborted) return;
        this.logger.warn({ event: 'event_inbox.claim.failed', error });
        recovered = false;
        await this.markDegraded(error);
        await this.wait(backoffMs);
        backoffMs = Math.min(30_000, backoffMs * 2);
      }
    }
  }

  async recover(): Promise<string> {
    const captured = await this.recoveryRequest();
    const watermark = captured.watermark;
    let remaining = captured.remaining;
    while (remaining > 0) {
      if (this.abort.signal.aborted) throw new Error('Event Inbox recovery aborted');
      const count = await this.runOnce({ waitSeconds: 0, throughSequence: watermark });
      const status = await this.recoveryRequest(watermark);
      remaining = status.remaining;
      if (remaining > 0 && count === 0) {
        await this.wait(this.config.EVENT_INBOX_POLL_INTERVAL_MS);
      }
    }
    await this.dispatchReadiness?.markReady(watermark);
    this.logger.log({ event: 'event_inbox.recovery.ready', watermark });
    return watermark;
  }

  async runOnce(options: { waitSeconds?: number; throughSequence?: string } = {}): Promise<number> {
    const baseUrl = this.config.EVENT_INBOX_BASE_URL!;
    const token = this.config.EVENT_INBOX_DEVICE_TOKEN!;
    const response = await this.request(baseUrl, token, '/api/v1/event-inbox/events/claim', {
      limit: this.config.EVENT_INBOX_BATCH_SIZE,
      waitSeconds: options.waitSeconds ?? 20,
      ...(options.throughSequence ? { throughSequence: options.throughSequence } : {}),
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

  private async recoveryRequest(watermark?: string): Promise<{
    watermark: string;
    remaining: number;
  }> {
    const response = await this.request(
      this.config.EVENT_INBOX_BASE_URL!,
      this.config.EVENT_INBOX_DEVICE_TOKEN!,
      '/api/v1/event-inbox/events/recovery',
      watermark ? { watermark } : {},
    );
    const parsed = eventInboxRecoveryResponseSchema.safeParse(response);
    if (!parsed.success) throw new Error('Event Inbox returned an invalid recovery response');
    return parsed.data;
  }

  private async markDegraded(error: unknown): Promise<void> {
    try {
      await this.dispatchReadiness?.markDegraded(
        error instanceof Error ? error.message : 'event_inbox_consumer_failed',
      );
    } catch (readinessError) {
      this.logger.error({ event: 'event_inbox.readiness.degrade_failed', error: readinessError });
    }
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
