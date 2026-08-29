import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../../src/core/database/database.service';
import { OpenWASafetyGovernorService } from '../../src/integrations/openwa/safety/openwa-safety-governor.service';
import {
  OpenWASafetyMutationConflictError,
  OpenWASafetyRepository,
} from '../../src/integrations/openwa/safety/openwa-safety.repository';
import { messageRequestHash } from '../../src/modules/messages/message-idempotency';
import { MessageJobRepository } from '../../src/modules/messages/message-job.repository';
import {
  INTEGRATION_GROUP_ID,
  INTEGRATION_SESSION_ID,
  integrationPool,
  resetIntegrationDatabase,
  seedSendableGroup,
} from '../support/integration-database';

describe('OpenWA Safety Governor', () => {
  let pool: Pool;
  let database: DatabaseService;
  let messages: MessageJobRepository;
  let safety: OpenWASafetyGovernorService;

  beforeAll(() => {
    pool = integrationPool();
    database = new DatabaseService();
    messages = new MessageJobRepository(database);
    safety = new OpenWASafetyGovernorService(new OpenWASafetyRepository(database));
  });
  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
    await seedSendableGroup(pool);
  });
  afterAll(async () => {
    await database.onApplicationShutdown();
    await pool.end();
  });

  it('commits one durable message boundary and defers the next burst before dispatch', async () => {
    const first = await createProcessingMessage('first', INTEGRATION_GROUP_ID);
    const decision = await safety.reserveMessage({
      sessionId: INTEGRATION_SESSION_ID,
      messageJobId: first,
      recipientId: INTEGRATION_GROUP_ID,
      operationClass: 'MESSAGE_SEND_TEXT',
    });
    expect(decision.outcome).toBe('GRANTED');
    if (decision.outcome !== 'GRANTED') return;
    const committed = await safety.commitMessageStart(decision.permit);
    expect(committed).toMatchObject({ upstreamAttemptNumber: 1 });
    await safety.recordOutcome(decision.permit, { kind: 'SUCCESS' });

    const secondRecipient = '120363000000000001@g.us';
    await pool.query(
      `INSERT INTO gateway_groups
         (session_id, id, name, is_admin, is_read_only, is_announce, details_synced_at,
          send_capability, send_capability_reason, capability_checked_at)
       VALUES ($1, $2, 'Second group', true, false, false, now(), 'ALLOWED', 'SEND_ALLOWED', now())`,
      [INTEGRATION_SESSION_ID, secondRecipient],
    );
    const second = await createProcessingMessage('second', secondRecipient);
    await expect(safety.reserveMessage({
      sessionId: INTEGRATION_SESSION_ID,
      messageJobId: second,
      recipientId: secondRecipient,
      operationClass: 'MESSAGE_SEND_TEXT',
    })).resolves.toMatchObject({ outcome: 'DEFERRED', reason: 'RATE_BUDGET' });
  });

  it('enforces one session send envelope across text and image messages', async () => {
    const first = await createProcessingMessage('mixed-first', INTEGRATION_GROUP_ID);
    const decision = await safety.reserveMessage({
      sessionId: INTEGRATION_SESSION_ID,
      messageJobId: first,
      recipientId: INTEGRATION_GROUP_ID,
      operationClass: 'MESSAGE_SEND_TEXT',
    });
    expect(decision.outcome).toBe('GRANTED');
    if (decision.outcome !== 'GRANTED') return;
    expect(await safety.commitMessageStart(decision.permit)).not.toBeNull();
    await safety.recordOutcome(decision.permit, { kind: 'SUCCESS' });

    const secondRecipient = '120363000000000002@g.us';
    await pool.query(
      `INSERT INTO gateway_groups
         (session_id, id, name, is_admin, is_read_only, is_announce, details_synced_at,
          send_capability, send_capability_reason, capability_checked_at)
       VALUES ($1, $2, 'Image group', true, false, false, now(), 'ALLOWED', 'SEND_ALLOWED', now())`,
      [INTEGRATION_SESSION_ID, secondRecipient],
    );
    const second = await createProcessingMessage('mixed-second', secondRecipient);
    await expect(safety.reserveMessage({
      sessionId: INTEGRATION_SESSION_ID,
      messageJobId: second,
      recipientId: secondRecipient,
      operationClass: 'MESSAGE_SEND_IMAGE',
    })).resolves.toMatchObject({ outcome: 'DEFERRED', reason: 'RATE_BUDGET' });
  });

  it('opens after a transient failure streak and permits exactly one recovery probe', async () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const decision = await safety.reserveOperation({
        sessionId: INTEGRATION_SESSION_ID,
        operationClass: 'GROUP_READ_TARGETED',
        holderType: 'GROUP_REFRESH',
        holderId: `failure-${attempt}`,
      });
      expect(decision.outcome).toBe('GRANTED');
      if (decision.outcome === 'GRANTED') {
        await safety.recordOutcome(decision.permit, { kind: 'TRANSIENT_FAILURE' });
      }
    }
    const cooldown = await safety.sessionSnapshot(INTEGRATION_SESSION_ID);
    expect(cooldown).toMatchObject({
      circuitState: 'OPEN', status: 'COOLDOWN', reason: 'UPSTREAM_FAILURE_STREAK',
    });
    await expect(safety.reserveOperation({
      sessionId: INTEGRATION_SESSION_ID,
      operationClass: 'GROUP_READ_TARGETED',
      holderType: 'PROBE',
      holderId: 'during-cooldown',
    })).resolves.toMatchObject({
      outcome: 'DEFERRED',
      reason: 'UPSTREAM_FAILURE_STREAK',
      notBefore: cooldown.cooldownUntil,
    });

    await pool.query(
      `UPDATE openwa_safety_scopes SET cooldown_until = now() - interval '1 second'
       WHERE circuit_state = 'OPEN'`,
    );
    const probe = await safety.reserveOperation({
      sessionId: INTEGRATION_SESSION_ID,
      operationClass: 'GROUP_READ_TARGETED',
      holderType: 'PROBE',
      holderId: 'recovery-one',
    });
    expect(probe.outcome).toBe('GRANTED');
    await expect(safety.reserveOperation({
      sessionId: INTEGRATION_SESSION_ID,
      operationClass: 'GROUP_READ_TARGETED',
      holderType: 'PROBE',
      holderId: 'recovery-two',
    })).resolves.toMatchObject({ outcome: 'DEFERRED', reason: 'RECOVERY_PROBE_IN_FLIGHT' });
    if (probe.outcome === 'GRANTED') await safety.recordOutcome(probe.permit, { kind: 'SUCCESS' });
    await expect(safety.sessionSnapshot(INTEGRATION_SESSION_ID)).resolves.toMatchObject({
      circuitState: 'CLOSED', status: 'READY', reason: null,
    });
  });

  it('recovers every throttled bucket in a scope together after the success threshold', async () => {
    const rateLimited = await safety.reserveOperation({
      sessionId: INTEGRATION_SESSION_ID,
      operationClass: 'GROUP_READ_TARGETED',
      holderType: 'GROUP_REFRESH',
      holderId: 'rate-limited-operation',
    });
    const recoverySuccess = await safety.reserveOperation({
      sessionId: INTEGRATION_SESSION_ID,
      operationClass: 'SESSION_READ',
      holderType: 'GATEWAY_SYNC',
      holderId: 'recovery-success',
    });
    expect(rateLimited.outcome).toBe('GRANTED');
    expect(recoverySuccess.outcome).toBe('GRANTED');
    if (rateLimited.outcome !== 'GRANTED' || recoverySuccess.outcome !== 'GRANTED') return;

    await safety.recordOutcome(rateLimited.permit, { kind: 'RATE_LIMITED', retryAfterMs: 1_000 });
    const throttled = await pool.query<{
      operation_class: string;
      emission_interval_ms: number;
      base_emission_interval_ms: number;
    }>(
      `SELECT operation_class, emission_interval_ms, base_emission_interval_ms
       FROM openwa_safety_buckets WHERE scope_type = 'SESSION' AND session_id = $1
       ORDER BY operation_class`,
      [INTEGRATION_SESSION_ID],
    );
    expect(throttled.rows.map(row => row.operation_class)).toEqual([
      'GROUP_READ_TARGETED', 'SESSION_READ',
    ]);
    expect(throttled.rows.every(row => (
      row.emission_interval_ms === row.base_emission_interval_ms * 2
    ))).toBe(true);

    await pool.query(
      `UPDATE openwa_safety_scopes SET cooldown_until = now() - interval '1 second',
         success_streak = CASE WHEN scope_type = 'SESSION' THEN 19 ELSE success_streak END
       WHERE scope_type IN ('WORKSPACE', 'UPSTREAM', 'SESSION')`,
    );
    await safety.recordOutcome(recoverySuccess.permit, { kind: 'SUCCESS' });

    const recovering = await pool.query<{
      operation_class: string;
      emission_interval_ms: number;
      base_emission_interval_ms: number;
    }>(
      `SELECT operation_class, emission_interval_ms, base_emission_interval_ms
       FROM openwa_safety_buckets WHERE scope_type = 'SESSION' AND session_id = $1
       ORDER BY operation_class`,
      [INTEGRATION_SESSION_ID],
    );
    expect(recovering.rows.map(row => row.operation_class)).toEqual([
      'GROUP_READ_TARGETED', 'SESSION_READ',
    ]);
    expect(recovering.rows.every((row, index) => (
      row.emission_interval_ms < throttled.rows[index]!.emission_interval_ms
      && row.emission_interval_ms >= row.base_emission_interval_ms
    ))).toBe(true);
  });

  it('applies session controls idempotently and rejects key reuse with another intent', async () => {
    const key = randomUUID();
    const request = {
      sessionId: INTEGRATION_SESSION_ID,
      operationType: 'OPENWA_SESSION_BLOCK' as const,
      idempotencyKey: key,
      requestHash: 'a'.repeat(64),
      reason: 'OPERATOR_REVIEW',
    };
    await expect(safety.mutateSession(request)).resolves.toMatchObject({
      circuitState: 'MANUAL_BLOCKED', status: 'BLOCKED', reason: 'OPERATOR_REVIEW',
    });
    await expect(safety.mutateSession(request)).resolves.toMatchObject({ revision: 2 });
    await expect(safety.mutateSession({ ...request, requestHash: 'b'.repeat(64) }))
      .rejects.toBeInstanceOf(OpenWASafetyMutationConflictError);
    const activity = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM activity_events
       WHERE event_type = 'openwa_safety.session_blocked' AND session_id = $1`,
      [INTEGRATION_SESSION_ID],
    );
    expect(activity.rows[0]?.count).toBe('1');
  });

  it('reports a parent safety intervention as the effective session state', async () => {
    await safety.sessionSnapshot(INTEGRATION_SESSION_ID);
    await pool.query(
      `UPDATE openwa_safety_scopes SET circuit_state = 'MANUAL_BLOCKED',
         reason_code = 'UPSTREAM_OPERATOR_BLOCK', manual_blocked_at = now()
       WHERE scope_type = 'UPSTREAM'`,
    );

    await expect(safety.sessionSnapshot(INTEGRATION_SESSION_ID)).resolves.toMatchObject({
      scopeType: 'SESSION',
      effectiveScopeType: 'UPSTREAM',
      circuitState: 'CLOSED',
      status: 'BLOCKED',
      reason: 'UPSTREAM_OPERATOR_BLOCK',
    });
  });

  it('keeps operator block authoritative and records an upstream outcome only once', async () => {
    const decision = await safety.reserveOperation({
      sessionId: INTEGRATION_SESSION_ID,
      operationClass: 'GROUP_READ_TARGETED',
      holderType: 'GROUP_REFRESH',
      holderId: 'operator-race',
    });
    expect(decision.outcome).toBe('GRANTED');
    if (decision.outcome !== 'GRANTED') return;
    await safety.mutateSession({
      sessionId: INTEGRATION_SESSION_ID,
      operationType: 'OPENWA_SESSION_BLOCK',
      idempotencyKey: randomUUID(),
      requestHash: 'd'.repeat(64),
      reason: 'EMERGENCY_STOP',
    });

    await safety.recordOutcome(decision.permit, { kind: 'TRANSIENT_FAILURE' });
    await safety.recordOutcome(decision.permit, { kind: 'TRANSIENT_FAILURE' });

    await expect(safety.sessionSnapshot(INTEGRATION_SESSION_ID)).resolves.toMatchObject({
      circuitState: 'MANUAL_BLOCKED', status: 'BLOCKED', reason: 'EMERGENCY_STOP',
    });
    expect((await pool.query<{ count: string; max_failures: number }>(
      `SELECT count(*)::text AS count,
         max(consecutive_transient_failures)::integer AS max_failures
       FROM openwa_safety_scopes WHERE consecutive_transient_failures = 1`,
    )).rows[0]).toEqual({ count: '3', max_failures: 1 });
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM openwa_safety_outcome_receipts
       WHERE permit_token = $1`,
      [decision.permit.permitToken],
    )).rows[0]?.count).toBe('1');
  });

  it('rechecks a manual stop at the final upstream commit fence', async () => {
    const messageJobId = await createProcessingMessage('final-fence', INTEGRATION_GROUP_ID);
    const decision = await safety.reserveMessage({
      sessionId: INTEGRATION_SESSION_ID,
      messageJobId,
      recipientId: INTEGRATION_GROUP_ID,
      operationClass: 'MESSAGE_SEND_TEXT',
    });
    expect(decision.outcome).toBe('GRANTED');
    if (decision.outcome !== 'GRANTED') return;

    await safety.mutateSession({
      sessionId: INTEGRATION_SESSION_ID,
      operationType: 'OPENWA_SESSION_BLOCK',
      idempotencyKey: randomUUID(),
      requestHash: 'c'.repeat(64),
      reason: 'EMERGENCY_STOP',
    });

    await expect(safety.commitMessageStart(decision.permit)).resolves.toBeNull();
    expect((await pool.query(
      'SELECT attempt_count, current_upstream_started_at FROM message_jobs WHERE id = $1',
      [messageJobId],
    )).rows[0]).toMatchObject({ attempt_count: 0, current_upstream_started_at: null });
  });

  it('rejects a permit whose operation class does not match the stored message type', async () => {
    const messageJobId = await createProcessingMessage('mismatched-operation', INTEGRATION_GROUP_ID);
    const decision = await safety.reserveMessage({
      sessionId: INTEGRATION_SESSION_ID,
      messageJobId,
      recipientId: INTEGRATION_GROUP_ID,
      operationClass: 'MESSAGE_SEND_IMAGE',
    });
    expect(decision.outcome).toBe('GRANTED');
    if (decision.outcome !== 'GRANTED') return;

    await expect(safety.commitMessageStart(decision.permit)).resolves.toBeNull();
    await safety.release(decision.permit);
    expect((await pool.query(
      'SELECT attempt_count, current_upstream_started_at FROM message_jobs WHERE id = $1',
      [messageJobId],
    )).rows[0]).toMatchObject({ attempt_count: 0, current_upstream_started_at: null });
  });

  it('rejects a stale message permit when recovery begins after reservation', async () => {
    const messageJobId = await createProcessingMessage('stale-recovery', INTEGRATION_GROUP_ID);
    const decision = await safety.reserveMessage({
      sessionId: INTEGRATION_SESSION_ID,
      messageJobId,
      recipientId: INTEGRATION_GROUP_ID,
      operationClass: 'MESSAGE_SEND_TEXT',
    });
    expect(decision.outcome).toBe('GRANTED');
    if (decision.outcome !== 'GRANTED') return;

    await pool.query(
      `UPDATE openwa_safety_scopes SET circuit_state = 'HALF_OPEN', cooldown_until = NULL,
         reason_code = 'RECOVERY_PROBE', revision = revision + 1, updated_at = now()`,
    );

    await expect(safety.commitMessageStart(decision.permit)).resolves.toBeNull();
    expect((await pool.query(
      'SELECT attempt_count, current_upstream_started_at FROM message_jobs WHERE id = $1',
      [messageJobId],
    )).rows[0]).toMatchObject({ attempt_count: 0, current_upstream_started_at: null });
  });

  async function createProcessingMessage(key: string, recipientId: string): Promise<string> {
    const text = `safety-${key}`;
    const created = await messages.create({
      idempotencyScope: 'openwa-safety-test',
      idempotencyKey: key,
      requestHash: messageRequestHash({
        sessionId: INTEGRATION_SESSION_ID,
        recipientId,
        text,
        scheduledAt: null,
        dryRun: false,
      }),
      sessionId: INTEGRATION_SESSION_ID,
      recipientId,
      text,
      scheduledAt: new Date(Date.now() - 1_000),
      dryRun: false,
    });
    await messages.claimDue(10);
    expect(await messages.markProcessing(created.job.id)).not.toBeNull();
    return created.job.id;
  }
});
