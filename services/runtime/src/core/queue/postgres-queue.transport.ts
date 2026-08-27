import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Notification, PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
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
  RuntimeQueueJob,
  RuntimeQueueName,
  RuntimeQueuePublishOptions,
  RuntimeQueueWorker,
} from './queue-transport';
import {
  RUNTIME_HEARTBEAT_TTL_SECONDS,
  type SchedulerTickState,
  type RuntimeProcessName,
} from './runtime-heartbeat';
import { runCleanupTasks, runWithCleanup } from '../process/run-with-cleanup';

const QUEUE_WAKEUP_CHANNEL = 'runtime_queue_wakeup';
const QUEUE_POLL_INTERVAL_MS = 1_000;
const QUEUE_ERROR_BACKOFF_MS = 1_000;
const QUEUE_LEASE_SECONDS = 90;
const QUEUE_LEASE_RENEWAL_MS = 30_000;

interface PostgresQueueRow<T> {
  job_id: string;
  job_name: string;
  payload: T;
  lease_owner: string;
}

interface QueueWaiter {
  queue: RuntimeQueueName;
  resolve: () => void;
  timeout?: NodeJS.Timeout;
}

@Injectable()
export class PostgresQueueTransport implements QueueTransport {
  private readonly workers = new Set<PostgresQueueWorker<unknown>>();
  private readonly listenerErrorHandlers = new Set<(error: Error) => void>();
  private readonly queueGenerations = new Map<RuntimeQueueName, number>();
  private readonly waiters = new Set<QueueWaiter>();
  private listenerClient: PoolClient | undefined;
  private listenerStart: Promise<void> | undefined;

  constructor(private readonly database: DatabaseService) {}

  async publish(
    queue: RuntimeQueueName,
    jobName: string,
    payload: unknown,
    options: RuntimeQueuePublishOptions,
  ): Promise<void> {
    const delay = Math.max(0, options.delay ?? 0);
    await this.database.query(
      `WITH inserted AS (
         INSERT INTO runtime_queue_jobs
           (queue_name, job_id, job_name, payload, priority, available_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, now() + ($6 * interval '1 millisecond'))
         ON CONFLICT (queue_name, job_id) DO NOTHING
         RETURNING 1
       )
       SELECT pg_notify('${QUEUE_WAKEUP_CHANNEL}', $1) FROM inserted`,
      [queue, options.jobId, jobName, JSON.stringify(payload), options.priority ?? null, delay],
    );
  }

  async publishHeartbeat(instanceId: string, processName: RuntimeProcessName): Promise<void> {
    await this.database.query(
      `INSERT INTO runtime_process_heartbeats (instance_id, process_name, heartbeat_at)
       VALUES ($1, $2, now())
       ON CONFLICT (instance_id, process_name) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at`,
      [instanceId, processName],
    );
  }

  async publishSchedulerTickState(state: SchedulerTickState): Promise<void> {
    await this.database.query(
      `INSERT INTO runtime_scheduler_tick_states (name, state, expires_at, updated_at)
       VALUES ($1, $2::jsonb, now() + interval '7 days', now())
       ON CONFLICT (name) DO UPDATE SET
         state = EXCLUDED.state,
         expires_at = EXCLUDED.expires_at,
         updated_at = EXCLUDED.updated_at`,
      [state.name, JSON.stringify(state)],
    );
  }

  startWorker<T>(
    queue: RuntimeQueueName,
    concurrency: number,
    processor: (job: RuntimeQueueJob<T>) => Promise<unknown>,
    onError: (error: Error) => void,
  ): RuntimeQueueWorker {
    this.listenerErrorHandlers.add(onError);
    void this.ensureListener();
    let worker!: PostgresQueueWorker<T>;
    worker = new PostgresQueueWorker(
      this,
      queue,
      concurrency,
      processor,
      onError,
      () => {
        this.workers.delete(worker as PostgresQueueWorker<unknown>);
        this.listenerErrorHandlers.delete(onError);
      },
    );
    this.workers.add(worker as PostgresQueueWorker<unknown>);
    return worker;
  }

  async readiness(): Promise<QueueReadiness> {
    await this.database.query('SELECT 1');
    return { backend: 'postgres', ready: true };
  }

  async runtimeProcessHealth(instanceId: string): Promise<RuntimeProcessHealth> {
    const result = await this.database.query<{ process_name: RuntimeProcessName }>(
      `SELECT process_name
       FROM runtime_process_heartbeats
       WHERE instance_id = $1
         AND heartbeat_at > now() - ($2 * interval '1 second')`,
      [instanceId, RUNTIME_HEARTBEAT_TTL_SECONDS],
    );
    const healthy = new Set(result.rows.map(row => row.process_name));
    return {
      worker: healthy.has('worker') ? 'healthy' : 'degraded',
      scheduler: healthy.has('scheduler') ? 'healthy' : 'degraded',
    };
  }

  async close(): Promise<void> {
    await runWithCleanup(
      () => runCleanupTasks([...this.workers].map(worker => () => worker.close())),
      async () => {
        this.workers.clear();
        this.listenerErrorHandlers.clear();
        this.wake();
        await this.closeListener();
      },
    );
  }

  async claim<T>(queue: RuntimeQueueName): Promise<PostgresQueueRow<T> | null> {
    const leaseOwner = randomUUID();
    const result = await this.database.query<PostgresQueueRow<T>>(
      `WITH next_job AS (
         SELECT queue_name, job_id
         FROM runtime_queue_jobs
         WHERE queue_name = $1
           AND available_at <= now()
           AND (lease_expires_at IS NULL OR lease_expires_at <= now())
         ORDER BY (priority IS NOT NULL), priority ASC NULLS FIRST, available_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE runtime_queue_jobs AS job
       SET lease_owner = $2,
           lease_expires_at = now() + ($3 * interval '1 second'),
           updated_at = now()
       FROM next_job
       WHERE job.queue_name = next_job.queue_name
         AND job.job_id = next_job.job_id
       RETURNING job.job_id, job.job_name, job.payload, job.lease_owner`,
      [queue, leaseOwner, QUEUE_LEASE_SECONDS],
    );
    return result.rows[0] ?? null;
  }

  async renew(queue: RuntimeQueueName, jobId: string, leaseOwner: string): Promise<void> {
    await this.database.query(
      `UPDATE runtime_queue_jobs
       SET lease_expires_at = now() + ($4 * interval '1 second'), updated_at = now()
       WHERE queue_name = $1 AND job_id = $2 AND lease_owner = $3`,
      [queue, jobId, leaseOwner, QUEUE_LEASE_SECONDS],
    );
  }

  async complete(queue: RuntimeQueueName, jobId: string, leaseOwner: string): Promise<void> {
    await this.database.query(
      `DELETE FROM runtime_queue_jobs
       WHERE queue_name = $1 AND job_id = $2 AND lease_owner = $3`,
      [queue, jobId, leaseOwner],
    );
  }

  generation(queue: RuntimeQueueName): number {
    return this.queueGenerations.get(queue) ?? 0;
  }

  waitForWork(queue: RuntimeQueueName, generation: number): Promise<void> {
    void this.ensureListener();
    if (this.generation(queue) !== generation) return Promise.resolve();

    return new Promise(resolve => {
      const waiter: QueueWaiter = {
        queue,
        resolve: () => {
          if (waiter.timeout) clearTimeout(waiter.timeout);
          this.waiters.delete(waiter);
          resolve();
        },
      };
      waiter.timeout = setTimeout(waiter.resolve, QUEUE_POLL_INTERVAL_MS);
      waiter.timeout.unref();
      this.waiters.add(waiter);
    });
  }

  wake(queue?: RuntimeQueueName): void {
    if (queue) {
      this.queueGenerations.set(queue, this.generation(queue) + 1);
    } else {
      for (const name of RUNTIME_QUEUE_NAMES) {
        this.queueGenerations.set(name, this.generation(name) + 1);
      }
    }
    for (const waiter of [...this.waiters]) {
      if (!queue || waiter.queue === queue) waiter.resolve();
    }
  }

  private ensureListener(): Promise<void> {
    if (this.listenerClient) return Promise.resolve();
    if (this.listenerStart) return this.listenerStart;

    const start = this.startListener();
    this.listenerStart = start;
    void start.catch(error => {
      if (this.listenerStart === start) this.listenerStart = undefined;
      this.reportListenerError(asError(error));
    });
    return start;
  }

  private async startListener(): Promise<void> {
    const client = await this.database.pool.connect();
    try {
      client.on('notification', this.onNotification);
      client.on('error', this.onListenerError);
      await client.query(`LISTEN ${QUEUE_WAKEUP_CHANNEL}`);
      this.listenerClient = client;
    } catch (error) {
      client.off('notification', this.onNotification);
      client.off('error', this.onListenerError);
      client.release(true);
      throw error;
    }
  }

  private async closeListener(): Promise<void> {
    await this.listenerStart?.catch(() => undefined);
    this.listenerStart = undefined;
    const client = this.listenerClient;
    this.listenerClient = undefined;
    if (!client) return;

    client.off('notification', this.onNotification);
    client.off('error', this.onListenerError);
    try {
      await client.query(`UNLISTEN ${QUEUE_WAKEUP_CHANNEL}`);
      client.release();
    } catch {
      client.release(true);
    }
  }

  private readonly onNotification = (notification: Notification): void => {
    if (notification.channel !== QUEUE_WAKEUP_CHANNEL) return;
    const queue = runtimeQueueName(notification.payload);
    if (queue) this.wake(queue);
  };

  private readonly onListenerError = (error: Error): void => {
    const client = this.listenerClient;
    this.listenerClient = undefined;
    this.listenerStart = undefined;
    if (client) {
      client.off('notification', this.onNotification);
      client.off('error', this.onListenerError);
      client.release(true);
    }
    this.reportListenerError(error);
    this.wake();
  };

  private reportListenerError(error: Error): void {
    for (const handler of this.listenerErrorHandlers) {
      try {
        handler(error);
      } catch {
        // A consumer error callback must not break PostgreSQL's connection event loop.
      }
    }
  }
}

class PostgresQueueWorker<T> implements RuntimeQueueWorker {
  private stopping = false;
  private readonly loops: Array<Promise<void>>;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly transport: PostgresQueueTransport,
    private readonly queue: RuntimeQueueName,
    concurrency: number,
    private readonly processor: (job: RuntimeQueueJob<T>) => Promise<unknown>,
    private readonly onError: (error: Error) => void,
    private readonly onClose: () => void,
  ) {
    this.loops = Array.from({ length: concurrency }, () => this.run());
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.stopping = true;
    this.transport.wake(this.queue);
    this.closePromise = Promise.all(this.loops).then(() => { this.onClose(); });
    return this.closePromise;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      const generation = this.transport.generation(this.queue);
      let claimed: PostgresQueueRow<T> | null;
      try {
        claimed = await this.transport.claim<T>(this.queue);
      } catch (error) {
        this.onError(asError(error));
        await pause(QUEUE_ERROR_BACKOFF_MS);
        continue;
      }
      if (!claimed) {
        await this.transport.waitForWork(this.queue, generation);
        continue;
      }

      const renewal = setInterval(() => {
        void this.transport
          .renew(this.queue, claimed!.job_id, claimed!.lease_owner)
          .catch(error => this.onError(asError(error)));
      }, QUEUE_LEASE_RENEWAL_MS);
      renewal.unref();
      try {
        await this.processor({
          id: claimed.job_id,
          name: claimed.job_name,
          payload: claimed.payload,
        });
      } catch {
        // Processors persist their own durable failure/retry state. This transport mirrors
        // the established BullMQ attempts=1 behavior by removing the delivery envelope.
      } finally {
        clearInterval(renewal);
        try {
          await this.transport.complete(this.queue, claimed.job_id, claimed.lease_owner);
        } catch (error) {
          this.onError(asError(error));
        }
      }
    }
  }
}

const RUNTIME_QUEUE_NAMES: readonly RuntimeQueueName[] = [
  MESSAGE_SEND_QUEUE,
  WEBHOOK_QUEUE,
  GATEWAY_SYNC_QUEUE,
  CAMPAIGN_QUEUE,
];

function runtimeQueueName(value: string | undefined): RuntimeQueueName | undefined {
  return RUNTIME_QUEUE_NAMES.find(queue => queue === value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function pause(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
