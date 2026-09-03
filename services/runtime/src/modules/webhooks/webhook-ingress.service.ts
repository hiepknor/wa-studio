import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { stableQueueJobId } from '../../core/queue/queue-job-id';
import { QueueService } from '../../core/queue/queue.service';
import { WEBHOOK_QUEUE } from '../../core/queue/queue.constants';
import { SessionScopeService } from '../gateway/session-scope.service';
import { verifyOpenWASignature } from './webhook-signature';
import {
  type OpenWAWebhookEnvelope,
  WebhookRepository,
  WebhookSpoolCapacityError,
} from './webhook.repository';

export interface WebhookIngressResult {
  accepted: true;
  duplicate: boolean;
}

@Injectable()
export class WebhookIngressService {
  constructor(
    private readonly repository: WebhookRepository,
    private readonly queues: QueueService,
    private readonly sessions: SessionScopeService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async accept(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    body: Partial<OpenWAWebhookEnvelope>,
  ): Promise<WebhookIngressResult> {
    if (!rawBody || !verifyOpenWASignature(rawBody, signature, this.config.OPENWA_WEBHOOK_SECRET)) {
      throw new UnauthorizedException('Invalid OpenWA webhook signature');
    }
    if (
      !body.event
      || !body.timestamp
      || !body.sessionId
      || !body.idempotencyKey
      || !body.deliveryId
      || !body.data
    ) {
      throw new BadRequestException('Invalid OpenWA webhook envelope');
    }

    const envelope = body as OpenWAWebhookEnvelope;
    this.sessions.assertAllowed(envelope.sessionId);
    let created: boolean;
    try {
      created = await this.repository.insert(envelope);
    } catch (error) {
      if (error instanceof WebhookSpoolCapacityError) {
        throw new ServiceUnavailableException('Runtime webhook spool capacity is exhausted');
      }
      throw error;
    }
    await this.queues.publish(
      WEBHOOK_QUEUE,
      'process-openwa-webhook',
      { idempotencyKey: envelope.idempotencyKey },
      {
        jobId: stableQueueJobId('webhook', envelope.idempotencyKey),
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    return { accepted: true, duplicate: !created };
  }
}
