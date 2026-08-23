import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { DatabaseService } from '../../src/core/database/database.service';
import { PostgresQueueTransport } from '../../src/core/queue/postgres-queue.transport';
import type { SchedulerTickState } from '../../src/core/queue/runtime-heartbeat';
import { integrationPool, resetIntegrationDatabase } from '../support/integration-database';

describe('PostgresQueueTransport', () => {
  let pool: Pool;
  let database: DatabaseService;
  let transport: PostgresQueueTransport;

  beforeAll(() => {
    pool = integrationPool();
    database = new DatabaseService();
    transport = new PostgresQueueTransport(database);
  });

  beforeEach(async () => {
    await transport.close();
    await resetIntegrationDatabase(pool);
  });

  afterAll(async () => {
    await transport.close();
    await database.onApplicationShutdown();
    await pool.end();
  });

  it('deduplicates publications and removes the delivery envelope after processing', async () => {
    const received: Array<{ id: string; payload: { value: number } }> = [];
    await transport.publish(
      'message-send',
      'test-message',
      { value: 1 },
      { jobId: 'job-1', attempts: 1 },
    );
    await transport.publish(
      'message-send',
      'test-message',
      { value: 2 },
      { jobId: 'job-1', attempts: 1 },
    );

    const worker = transport.startWorker<{ value: number }>(
      'message-send',
      2,
      async job => { received.push({ id: job.id, payload: job.payload }); },
      error => { throw error; },
    );
    await vi.waitFor(() => expect(received).toEqual([{
      id: 'job-1', payload: { value: 1 },
    }]));
    await worker.close();

    const remaining = await pool.query('SELECT count(*)::int AS count FROM runtime_queue_jobs');
    expect(remaining.rows[0]?.count).toBe(0);
  });

  it('does not claim a delayed delivery before its availability time', async () => {
    const received: string[] = [];
    await transport.publish(
      'gateway-sync',
      'delayed-sync',
      { syncRunId: 'run-1' },
      { jobId: 'run-1', attempts: 1, delay: 500 },
    );
    const worker = transport.startWorker<{ syncRunId: string }>(
      'gateway-sync',
      1,
      async job => { received.push(job.payload.syncRunId); },
      error => { throw error; },
    );

    await new Promise(resolve => setTimeout(resolve, 200));
    expect(received).toEqual([]);
    await vi.waitFor(() => expect(received).toEqual(['run-1']), { timeout: 2_000 });
    await worker.close();
  });

  it('wakes an idle worker through PostgreSQL notifications without waiting for fallback polling', async () => {
    const received: string[] = [];
    const worker = transport.startWorker<{ value: string }>(
      'webhook-ingress',
      1,
      async job => { received.push(job.payload.value); },
      error => { throw error; },
    );
    await new Promise(resolve => setTimeout(resolve, 200));

    await transport.publish(
      'webhook-ingress',
      'notify-test',
      { value: 'received' },
      { jobId: 'notify-job', attempts: 1 },
    );

    await vi.waitFor(() => expect(received).toEqual(['received']), { timeout: 700 });
    await worker.close();
  });

  it('reclaims a delivery after its previous worker lease expires', async () => {
    await transport.publish(
      'campaign',
      'lease-recovery',
      { campaignRunId: 'run-1' },
      { jobId: 'lease-job', attempts: 1 },
    );
    const abandoned = await transport.claim('campaign');
    expect(abandoned?.job_id).toBe('lease-job');
    await pool.query(
      `UPDATE runtime_queue_jobs
       SET lease_expires_at = now() - interval '1 second'
       WHERE queue_name = 'campaign' AND job_id = 'lease-job'`,
    );

    const received: string[] = [];
    const worker = transport.startWorker<{ campaignRunId: string }>(
      'campaign',
      1,
      async job => { received.push(job.payload.campaignRunId); },
      error => { throw error; },
    );
    await vi.waitFor(() => expect(received).toEqual(['run-1']));
    await worker.close();

    const remaining = await pool.query(
      `SELECT count(*)::int AS count
       FROM runtime_queue_jobs
       WHERE queue_name = 'campaign' AND job_id = 'lease-job'`,
    );
    expect(remaining.rows[0]?.count).toBe(0);
  });

  it('stores process health and scheduler telemetry in PostgreSQL', async () => {
    const state: SchedulerTickState = {
      name: 'messages', running: false, timedOut: false, consecutiveFailures: 0,
      lastStartedAt: null, lastSuccessAt: new Date().toISOString(), lastFailureAt: null,
      lastDurationMs: 1, nextRunAt: null,
    };

    await transport.publishHeartbeat('integration-instance', 'worker');
    await transport.publishHeartbeat('integration-instance', 'scheduler');
    await transport.publishSchedulerTickState(state);

    await expect(transport.readiness()).resolves.toEqual({ backend: 'postgres', ready: true });
    await expect(transport.runtimeProcessHealth('integration-instance')).resolves.toEqual({
      worker: 'healthy', scheduler: 'healthy',
    });
    await expect(transport.runtimeProcessHealth('another-instance')).resolves.toEqual({
      worker: 'degraded', scheduler: 'degraded',
    });
    const telemetry = await pool.query(
      'SELECT state FROM runtime_scheduler_tick_states WHERE name = $1',
      ['messages'],
    );
    expect(telemetry.rows[0]?.state).toMatchObject({ name: 'messages', lastDurationMs: 1 });
  });
});
