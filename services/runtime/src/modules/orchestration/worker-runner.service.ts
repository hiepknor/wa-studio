import { Inject, Injectable, Logger } from '@nestjs/common';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { withCorrelationContext } from '../../core/observability/correlation-context';
import { CAMPAIGN_QUEUE, GATEWAY_SYNC_QUEUE, MESSAGE_SEND_QUEUE, WEBHOOK_QUEUE } from '../../core/queue/queue.constants';
import { RUNTIME_HEARTBEAT_INTERVAL_MS } from '../../core/queue/runtime-heartbeat';
import { QueueService } from '../../core/queue/queue.service';
import { CampaignRunProcessorService } from '../campaigns/campaign-run-processor.service';
import { GatewaySyncProcessorService } from '../gateway/gateway-sync-processor.service';
import type { FullGatewaySyncPayload, GroupCapabilityRefreshPayload, GroupReconciliationPayload, TargetedGroupReconciliationPayload } from '../gateway/gateway-sync.types';
import { MessageJobProcessorService } from '../messages/message-job-processor.service';
import type { MessageSendQueuePayload } from '../messages/message-job.types';
import { WebhookProcessorService } from '../webhooks/webhook-processor.service';

@Injectable()
export class WorkerRunnerService {
  private readonly logger = new Logger(WorkerRunnerService.name);

  constructor(
    private readonly messageProcessor: MessageJobProcessorService,
    private readonly webhookProcessor: WebhookProcessorService,
    private readonly gatewayProcessor: GatewaySyncProcessorService,
    private readonly campaignProcessor: CampaignRunProcessorService,
    private readonly queues: QueueService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async run(): Promise<void> {
    const config = this.config;
    const messageWorker = this.queues.startWorker<MessageSendQueuePayload>(
      MESSAGE_SEND_QUEUE,
      config.MESSAGE_WORKER_CONCURRENCY,
      job => this.runJob('message_send', job.name, job.id, {
        messageJobId: job.payload.messageJobId,
      }, () => this.messageProcessor.process(job.payload)),
      error => this.logger.error({ event: 'worker.connection.error', queue: MESSAGE_SEND_QUEUE, error }),
    );
    const webhookWorker = this.queues.startWorker<{ idempotencyKey: string }>(
      WEBHOOK_QUEUE,
      config.WEBHOOK_WORKER_CONCURRENCY,
      job => this.runJob('webhook_ingress', job.name, job.id, {
        webhookIdempotencyKey: job.payload.idempotencyKey,
      }, () => this.webhookProcessor.process(job.payload.idempotencyKey)),
      error => this.logger.error({ event: 'worker.connection.error', queue: WEBHOOK_QUEUE, error }),
    );
    const gatewayWorker = this.queues.startWorker<FullGatewaySyncPayload | GroupCapabilityRefreshPayload | GroupReconciliationPayload | TargetedGroupReconciliationPayload>(
      GATEWAY_SYNC_QUEUE,
      config.GATEWAY_WORKER_CONCURRENCY,
      job => this.runJob('gateway_sync', job.name, job.id, {
        sessionId: job.payload.sessionId,
        ...('syncRunId' in job.payload ? { syncRunId: job.payload.syncRunId } : {}),
      }, () => this.gatewayProcessor.process(job.name, job.payload)),
      error => this.logger.error({ event: 'worker.connection.error', queue: GATEWAY_SYNC_QUEUE, error }),
    );
    const campaignWorker = this.queues.startWorker<{ runId: string }>(
      CAMPAIGN_QUEUE,
      config.CAMPAIGN_WORKER_CONCURRENCY,
      job => this.runJob('campaign', job.name, job.id, {
        campaignRunId: job.payload.runId,
      }, () => this.campaignProcessor.process(job.payload.runId)),
      error => this.logger.error({ event: 'worker.connection.error', queue: CAMPAIGN_QUEUE, error }),
    );
    const workers = [messageWorker, webhookWorker, gatewayWorker, campaignWorker];
    const heartbeat = setInterval(() => void this.publishHeartbeat(), RUNTIME_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
    await this.publishHeartbeat();
    await new Promise<void>(resolve => {
      process.once('SIGTERM', resolve);
      process.once('SIGINT', resolve);
    });
    await Promise.all(workers.map(worker => worker.close()));
    clearInterval(heartbeat);
  }

  private async publishHeartbeat(): Promise<void> {
    try {
      await this.queues.publishHeartbeat('worker');
    } catch (error) {
      this.logger.error({ event: 'runtime.heartbeat.failed', process: 'worker', error });
    }
  }

  private runJob<T>(
    queue: string,
    jobName: string,
    queueJobId: string,
    context: Record<string, string>,
    operation: () => Promise<T>,
  ): Promise<T> {
    return withCorrelationContext({ queueJobId, ...context }, async () => {
      try {
        return await operation();
      } catch (error) {
        this.logger.error({ event: 'worker.job.failed', queue, jobName, error });
        throw error;
      }
    });
  }
}
