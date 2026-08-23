import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { runtimeConfig, type RuntimeConfig } from '../config/runtime-config';
import { RUNTIME_CONFIG } from '../config/runtime-config.module';
import { RedisQueueTransport } from './redis-queue.transport';
import {
  QUEUE_TRANSPORT,
  type QueueTransport,
  type QueueReadiness,
  type RuntimeProcessHealth,
  type RuntimeQueueName,
  type RuntimeQueueJob,
  type RuntimeQueuePublishOptions,
  type RuntimeQueueWorker,
} from './queue-transport';
import type { SchedulerTickState, RuntimeProcessName } from './runtime-heartbeat';

export type { QueueReadiness, RuntimeProcessHealth } from './queue-transport';

@Injectable()
export class QueueService implements OnApplicationShutdown {
  constructor(
    @Inject(QUEUE_TRANSPORT)
    private readonly transport: QueueTransport = new RedisQueueTransport(),
    @Inject(RUNTIME_CONFIG)
    private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  publish(
    queue: RuntimeQueueName,
    jobName: string,
    payload: unknown,
    options: RuntimeQueuePublishOptions,
  ): Promise<void> {
    return this.transport.publish(queue, jobName, payload, options);
  }

  startWorker<T>(
    queue: RuntimeQueueName,
    concurrency: number,
    processor: (job: RuntimeQueueJob<T>) => Promise<unknown>,
    onError: (error: Error) => void,
  ): RuntimeQueueWorker {
    return this.transport.startWorker(queue, concurrency, processor, onError);
  }

  async publishHeartbeat(processName: RuntimeProcessName): Promise<void> {
    await this.transport.publishHeartbeat(this.config.RUNTIME_INSTANCE_ID, processName);
  }

  async publishSchedulerTickState(state: SchedulerTickState): Promise<void> {
    await this.transport.publishSchedulerTickState(state);
  }

  async readiness(): Promise<QueueReadiness> {
    return this.transport.readiness();
  }

  async runtimeProcessHealth(): Promise<RuntimeProcessHealth> {
    return this.transport.runtimeProcessHealth(this.config.RUNTIME_INSTANCE_ID);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.transport.close();
  }
}
