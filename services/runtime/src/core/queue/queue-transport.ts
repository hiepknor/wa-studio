import type { SchedulerTickState, RuntimeProcessName } from './runtime-heartbeat';
import {
  CAMPAIGN_QUEUE,
  GATEWAY_SYNC_QUEUE,
  MESSAGE_SEND_QUEUE,
  WEBHOOK_QUEUE,
} from './queue.constants';

export const QUEUE_TRANSPORT = Symbol('QUEUE_TRANSPORT');

export type QueueBackend = 'redis' | 'postgres';

export interface QueueReadiness {
  backend: QueueBackend;
  ready: true;
}

export type RuntimeProcessHealthStatus = 'healthy' | 'degraded';

export interface RuntimeProcessHealth {
  worker: RuntimeProcessHealthStatus;
  scheduler: RuntimeProcessHealthStatus;
}

export type RuntimeQueueName =
  | typeof MESSAGE_SEND_QUEUE
  | typeof WEBHOOK_QUEUE
  | typeof GATEWAY_SYNC_QUEUE
  | typeof CAMPAIGN_QUEUE;

export interface RuntimeQueuePublishOptions {
  jobId: string;
  attempts: number;
  priority?: number;
  delay?: number;
  removeOnComplete?: boolean | number;
  removeOnFail?: boolean | number;
}

export interface RuntimeQueueJob<T> {
  id: string;
  name: string;
  payload: T;
}

export interface RuntimeQueueWorker {
  close(): Promise<void>;
}

export interface QueueTransport {
  publish(
    queue: RuntimeQueueName,
    jobName: string,
    payload: unknown,
    options: RuntimeQueuePublishOptions,
  ): Promise<void>;
  publishHeartbeat(instanceId: string, processName: RuntimeProcessName): Promise<void>;
  publishSchedulerTickState(state: SchedulerTickState): Promise<void>;
  startWorker<T>(
    queue: RuntimeQueueName,
    concurrency: number,
    processor: (job: RuntimeQueueJob<T>) => Promise<unknown>,
    onError: (error: Error) => void,
  ): RuntimeQueueWorker;
  readiness(): Promise<QueueReadiness>;
  runtimeProcessHealth(instanceId: string): Promise<RuntimeProcessHealth>;
  close(): Promise<void>;
}
