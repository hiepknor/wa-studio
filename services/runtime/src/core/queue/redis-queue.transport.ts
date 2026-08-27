import { Inject, Injectable, Logger } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { runtimeConfig, type RuntimeConfig } from '../config/runtime-config';
import { RUNTIME_CONFIG } from '../config/runtime-config.module';
import {
  CAMPAIGN_QUEUE,
  GATEWAY_SYNC_QUEUE,
  MESSAGE_SEND_QUEUE,
  WEBHOOK_QUEUE,
} from './queue.constants';
import type {
  QueueReadiness,
  QueueTransport,
  RuntimeProcessHealth,
  RuntimeQueueName,
  RuntimeQueueJob,
  RuntimeQueuePublishOptions,
  RuntimeQueueWorker,
} from './queue-transport';
import {
  RUNTIME_HEARTBEAT_TTL_SECONDS,
  runtimeHeartbeatKey,
  schedulerTickStateKey,
  type SchedulerTickState,
  type RuntimeProcessName,
} from './runtime-heartbeat';
import { runCleanupTasks, runWithCleanup } from '../process/run-with-cleanup';

@Injectable()
export class RedisQueueTransport implements QueueTransport {
  private readonly logger = new Logger(RedisQueueTransport.name);
  private readonly connection: IORedis;
  private readonly healthConnection: IORedis;
  private readonly config: RuntimeConfig;
  private workerConnection: IORedis | undefined;
  private readonly workers = new Set<Worker>();
  private readonly workerClosures = new Map<Worker, Promise<void>>();
  readonly messageSend: Queue;
  readonly webhookIngress: Queue;
  readonly gatewaySync: Queue;
  readonly campaign: Queue;

  constructor(@Inject(RUNTIME_CONFIG) config: RuntimeConfig = runtimeConfig()) {
    this.config = config;
    const redisUrl = config.REDIS_URL;
    if (!redisUrl) throw new Error('Redis queue transport requires REDIS_URL');
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.healthConnection = new IORedis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
    });
    this.messageSend = new Queue(MESSAGE_SEND_QUEUE, { connection: this.connection });
    this.webhookIngress = new Queue(WEBHOOK_QUEUE, { connection: this.connection });
    this.gatewaySync = new Queue(GATEWAY_SYNC_QUEUE, { connection: this.connection });
    this.campaign = new Queue(CAMPAIGN_QUEUE, { connection: this.connection });
    this.connection.on('error', error => this.logConnectionError('queue', error));
    this.healthConnection.on('error', error => this.logConnectionError('health', error));
  }

  async publish(
    queue: RuntimeQueueName,
    jobName: string,
    payload: unknown,
    options: RuntimeQueuePublishOptions,
  ): Promise<void> {
    await this.queue(queue).add(jobName, payload, options);
  }

  async publishHeartbeat(instanceId: string, processName: RuntimeProcessName): Promise<void> {
    await this.ensureHealthConnection();
    const value = new Date().toISOString();
    await this.healthConnection.set(
      runtimeHeartbeatKey(instanceId, processName),
      value,
      'EX',
      RUNTIME_HEARTBEAT_TTL_SECONDS,
    );
  }

  async publishSchedulerTickState(state: SchedulerTickState): Promise<void> {
    await this.ensureHealthConnection();
    const value = JSON.stringify(state);
    const ttl = 7 * 24 * 60 * 60;
    await this.healthConnection.set(schedulerTickStateKey(state.name), value, 'EX', ttl);
  }

  startWorker<T>(
    queue: RuntimeQueueName,
    concurrency: number,
    processor: (job: RuntimeQueueJob<T>) => Promise<unknown>,
    onError: (error: Error) => void,
  ): RuntimeQueueWorker {
    const redisUrl = this.config.REDIS_URL;
    if (!redisUrl) throw new Error('Redis queue transport requires REDIS_URL');
    this.workerConnection ??= new IORedis(redisUrl, { maxRetriesPerRequest: null });
    const worker = new Worker<T>(
      queue,
      job => processor({ id: String(job.id), name: job.name, payload: job.data }),
      { connection: this.workerConnection, concurrency },
    );
    worker.on('error', onError);
    this.workers.add(worker);
    return {
      close: () => this.closeWorker(worker),
    };
  }

  async readiness(): Promise<QueueReadiness> {
    await this.ensureHealthConnection();
    const pong = await this.healthConnection.ping();
    if (pong !== 'PONG') throw new Error('Redis readiness check failed');
    return { backend: 'redis', ready: true };
  }

  async runtimeProcessHealth(instanceId: string): Promise<RuntimeProcessHealth> {
    await this.ensureHealthConnection();
    const [worker, scheduler] = await this.healthConnection.mget(
      runtimeHeartbeatKey(instanceId, 'worker'),
      runtimeHeartbeatKey(instanceId, 'scheduler'),
    );
    return {
      worker: worker ? 'healthy' : 'degraded',
      scheduler: scheduler ? 'healthy' : 'degraded',
    };
  }

  async close(): Promise<void> {
    await runWithCleanup(
      () => runCleanupTasks([
        ...[...this.workers].map(worker => () => this.closeWorker(worker)),
        () => this.messageSend.close(),
        () => this.webhookIngress.close(),
        () => this.gatewaySync.close(),
        () => this.campaign.close(),
      ]),
      () => {
        this.connection.disconnect();
        this.healthConnection.disconnect();
        this.workerConnection?.disconnect();
        this.workers.clear();
        this.workerClosures.clear();
      },
    );
  }

  private closeWorker(worker: Worker): Promise<void> {
    const existing = this.workerClosures.get(worker);
    if (existing) return existing;
    const closing = Promise.resolve()
      .then(() => worker.close())
      .finally(() => {
        this.workers.delete(worker);
        this.workerClosures.delete(worker);
      });
    this.workerClosures.set(worker, closing);
    return closing;
  }

  private queue(name: RuntimeQueueName): Queue {
    switch (name) {
      case MESSAGE_SEND_QUEUE: return this.messageSend;
      case WEBHOOK_QUEUE: return this.webhookIngress;
      case GATEWAY_SYNC_QUEUE: return this.gatewaySync;
      case CAMPAIGN_QUEUE: return this.campaign;
    }
  }

  private async ensureHealthConnection(): Promise<void> {
    if (this.healthConnection.status === 'wait') await this.healthConnection.connect();
  }

  private logConnectionError(connection: 'queue' | 'health', error: Error): void {
    this.logger.warn({
      event: 'redis.connection.error',
      connection,
      code: 'code' in error && typeof error.code === 'string' ? error.code : undefined,
    });
  }
}
