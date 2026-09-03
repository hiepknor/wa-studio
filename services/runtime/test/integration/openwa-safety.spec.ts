import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../../src/core/database/database.service';
import { OpenWASafetyGovernorService } from '../../src/integrations/openwa/safety/openwa-safety-governor.service';
import {
  OpenWASafetyMutationConflictError,
  OpenWASafetyRepository,
} from '../../src/integrations/openwa/safety/openwa-safety.repository';
import { MessageDeliveryEvidenceService } from '../../src/modules/messages/message-delivery-evidence.service';
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
  let safetyRepository: OpenWASafetyRepository;
  let safety: OpenWASafetyGovernorService;

  beforeAll(() => {
    pool = integrationPool();
    database = new DatabaseService();
    messages = new MessageJobRepository(database);
    safetyRepository = new OpenWASafetyRepository(database);
    safety = new OpenWASafetyGovernorService(safetyRepository);
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

  it('layers a manual hold over automatic cooldown and preserves rate debt when resumed', async () => {
    const decision = await safety.reserveOperation({
      sessionId: INTEGRATION_SESSION_ID,
      operationClass: 'GROUP_READ_TARGETED',
      holderType: 'GROUP_REFRESH',
      holderId: 'rate-debt-before-hold',
    });
    expect(decision.outcome).toBe('GRANTED');
    if (decision.outcome !== 'GRANTED') return;
    await safety.recordOutcome(decision.permit, { kind: 'RATE_LIMITED', retryAfterMs: 120_000 });

    const before = (await pool.query<{
      circuit_state: string;
      rate_mode: string;
      reason_code: string | null;
      cooldown_until: Date | null;
      consecutive_rate_limits: number;
      success_streak: number;
      theoretical_arrival_at: Date;
      emission_interval_ms: number;
    }>(
      `SELECT scopes.circuit_state, scopes.rate_mode, scopes.reason_code, scopes.cooldown_until,
         scopes.consecutive_rate_limits, scopes.success_streak,
         buckets.theoretical_arrival_at, buckets.emission_interval_ms
       FROM openwa_safety_scopes scopes
       JOIN openwa_safety_buckets buckets USING (scope_type, upstream_id, session_id)
       WHERE scopes.scope_type = 'SESSION' AND scopes.session_id = $1
         AND buckets.operation_class = 'GROUP_READ_TARGETED'`,
      [INTEGRATION_SESSION_ID],
    )).rows[0]!;

    await expect(safety.mutateSession({
      sessionId: INTEGRATION_SESSION_ID,
      operationType: 'OPENWA_SESSION_BLOCK',
      idempotencyKey: randomUUID(),
      requestHash: '1'.repeat(64),
      reason: 'OPERATOR_REVIEW',
    })).resolves.toMatchObject({
      circuitState: 'MANUAL_BLOCKED', status: 'BLOCKED', reason: 'OPERATOR_REVIEW',
    });

    await expect(safety.mutateSession({
      sessionId: INTEGRATION_SESSION_ID,
      operationType: 'OPENWA_SESSION_RESUME',
      idempotencyKey: randomUUID(),
      requestHash: '2'.repeat(64),
    })).resolves.toMatchObject({ status: 'COOLDOWN', reason: 'UPSTREAM_RATE_LIMIT' });

    const after = (await pool.query<typeof before>(
      `SELECT scopes.circuit_state, scopes.rate_mode, scopes.reason_code, scopes.cooldown_until,
         scopes.consecutive_rate_limits, scopes.success_streak,
         buckets.theoretical_arrival_at, buckets.emission_interval_ms
       FROM openwa_safety_scopes scopes
       JOIN openwa_safety_buckets buckets USING (scope_type, upstream_id, session_id)
       WHERE scopes.scope_type = 'SESSION' AND scopes.session_id = $1
         AND buckets.operation_class = 'GROUP_READ_TARGETED'`,
      [INTEGRATION_SESSION_ID],
    )).rows[0]!;
    expect(after).toEqual(before);
  });

  it('pauses only message admission and rechecks the hold at the final commit fence', async () => {
    const messageJobId = await createProcessingMessage('outbound-hold-fence', INTEGRATION_GROUP_ID);
    const reserved = await safety.reserveMessage({
      sessionId: INTEGRATION_SESSION_ID,
      messageJobId,
      recipientId: INTEGRATION_GROUP_ID,
      operationClass: 'MESSAGE_SEND_TEXT',
    });
    expect(reserved.outcome).toBe('GRANTED');
    if (reserved.outcome !== 'GRANTED') return;

    await expect(safety.mutateSession({
      sessionId: INTEGRATION_SESSION_ID,
      operationType: 'OPENWA_OUTBOUND_PAUSE',
      idempotencyKey: randomUUID(),
      requestHash: '3'.repeat(64),
      reason: 'OPERATOR_PAUSED_SENDS',
    })).resolves.toMatchObject({
      status: 'READY',
      outboundState: 'PAUSED',
      outboundPauseReason: 'OPERATOR_PAUSED_SENDS',
    });

    await expect(safety.commitMessageStart(reserved.permit)).resolves.toBeNull();
    await safety.release(reserved.permit);
    expect((await pool.query(
      'SELECT attempt_count, current_upstream_started_at FROM message_jobs WHERE id = $1',
      [messageJobId],
    )).rows[0]).toMatchObject({ attempt_count: 0, current_upstream_started_at: null });

    const blockedJob = await createProcessingMessage('outbound-hold-admission', INTEGRATION_GROUP_ID);
    await expect(safety.reserveMessage({
      sessionId: INTEGRATION_SESSION_ID,
      messageJobId: blockedJob,
      recipientId: INTEGRATION_GROUP_ID,
      operationClass: 'MESSAGE_SEND_TEXT',
    })).resolves.toMatchObject({ outcome: 'BLOCKED', reason: 'OPERATOR_PAUSED_SENDS' });

    await expect(safety.reserveOperation({
      sessionId: INTEGRATION_SESSION_ID,
      operationClass: 'GROUP_READ_TARGETED',
      holderType: 'GROUP_REFRESH',
      holderId: 'reads-continue-during-outbound-hold',
    })).resolves.toMatchObject({ outcome: 'GRANTED' });

    await expect(safety.mutateSession({
      sessionId: INTEGRATION_SESSION_ID,
      operationType: 'OPENWA_OUTBOUND_RESUME',
      idempotencyKey: randomUUID(),
      requestHash: '4'.repeat(64),
    })).resolves.toMatchObject({ status: 'READY', outboundState: 'RUNNING' });

    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM activity_events
       WHERE event_type IN ('openwa_safety.outbound_paused', 'openwa_safety.outbound_resumed')
         AND session_id = $1`,
      [INTEGRATION_SESSION_ID],
    )).rows[0]?.count).toBe('2');
  });

  it('forecasts message admission without consuming buckets or changing safety state', async () => {
    await safety.sessionSnapshot(INTEGRATION_SESSION_ID);
    const beforeScopes = (await pool.query(
      `SELECT scope_type, revision FROM openwa_safety_scopes
       WHERE scope_type IN ('WORKSPACE', 'UPSTREAM', 'SESSION') ORDER BY scope_type`,
    )).rows;
    expect((await pool.query('SELECT count(*)::integer AS count FROM openwa_safety_buckets')).rows[0])
      .toEqual({ count: 0 });

    const forecast = await safety.forecastMessages({
      sessionId: INTEGRATION_SESSION_ID,
      recipientIds: [INTEGRATION_GROUP_ID, '120363000000000099@g.us'],
      operationClass: 'MESSAGE_SEND_TEXT',
    });

    expect(forecast).toMatchObject({
      status: 'READY', reason: null, targetCount: 2, messageUnits: 2,
      queuedMessagesAhead: 0, recipientDeferredTargets: 0,
    });
    expect(forecast.estimatedFirstAdmissionAt).not.toBeNull();
    expect(forecast.estimatedLastAdmissionAt).not.toBeNull();
    expect(forecast.estimatedLastAdmissionAt!.valueOf() - forecast.estimatedFirstAdmissionAt!.valueOf())
      .toBeGreaterThanOrEqual(20_000);
    expect(forecast.estimatedSpanSeconds).toBeGreaterThanOrEqual(20);
    expect((await pool.query('SELECT count(*)::integer AS count FROM openwa_safety_buckets')).rows[0])
      .toEqual({ count: 0 });
    expect((await pool.query(
      `SELECT scope_type, revision FROM openwa_safety_scopes
       WHERE scope_type IN ('WORKSPACE', 'UPSTREAM', 'SESSION') ORDER BY scope_type`,
    )).rows).toEqual(beforeScopes);
  });

  it('surfaces recipient windows and queued live work in the forecast', async () => {
    await safety.sessionSnapshot(INTEGRATION_SESSION_ID);
    const historicalJob = await createProcessingMessage('forecast-recipient-history', INTEGRATION_GROUP_ID);
    await pool.query(
      `UPDATE message_jobs SET status = 'ACCEPTED', dry_run = false,
         current_upstream_started_at = now(), updated_at = now() WHERE id = $1`,
      [historicalJob],
    );
    const queuedJob = await createQueuedMessage(
      'forecast-queued-work',
      '120363000000000098@g.us',
      false,
    );

    const forecast = await safety.forecastMessages({
      sessionId: INTEGRATION_SESSION_ID,
      recipientIds: [INTEGRATION_GROUP_ID, '120363000000000099@g.us'],
      operationClass: 'MESSAGE_SEND_IMAGE',
    });

    expect(forecast).toMatchObject({
      status: 'WAITING', reason: 'QUEUED_WORK_AHEAD', targetCount: 2, messageUnits: 4,
      queuedMessagesAhead: 1, recipientDeferredTargets: 1,
    });
    expect(forecast.estimatedLastAdmissionAt!.valueOf() - forecast.calculatedAt.valueOf())
      .toBeGreaterThanOrEqual(6 * 60 * 60 * 1_000 - 1_000);
  });

  it('reports quiescence only after processing work and active safety leases drain', async () => {
    const messageJobId = await createProcessingMessage('quiescence', INTEGRATION_GROUP_ID);
    const decision = await safety.reserveMessage({
      sessionId: INTEGRATION_SESSION_ID,
      messageJobId,
      recipientId: INTEGRATION_GROUP_ID,
      operationClass: 'MESSAGE_SEND_TEXT',
    });
    expect(decision.outcome).toBe('GRANTED');
    if (decision.outcome !== 'GRANTED') return;

    await expect(safety.sessionQuiescence(INTEGRATION_SESSION_ID)).resolves.toMatchObject({
      drained: false,
      processingMessageJobs: 1,
      activeSafetyLeases: 1,
    });

    await safety.release(decision.permit);
    await pool.query(
      `UPDATE message_jobs SET status = 'FAILED', lease_expires_at = NULL,
         current_upstream_started_at = NULL, updated_at = now()
       WHERE id = $1`,
      [messageJobId],
    );
    await expect(safety.sessionQuiescence(INTEGRATION_SESSION_ID)).resolves.toMatchObject({
      drained: true,
      processingMessageJobs: 0,
      unsettledConnectorCommands: 0,
      activeSafetyLeases: 0,
    });
  });

  it('blocks the workspace across session identity changes and resumes idempotently', async () => {
    const block = {
      sessionId: INTEGRATION_SESSION_ID,
      operationType: 'OPENWA_WORKSPACE_BLOCK' as const,
      idempotencyKey: randomUUID(),
      requestHash: 'e'.repeat(64),
      reason: 'MANAGED_RUNTIME_RECONFIGURATION',
    };
    const blocked = await safety.mutateWorkspace(block);
    expect(blocked).toMatchObject({
      effectiveScopeType: 'WORKSPACE',
      status: 'BLOCKED',
      reason: 'MANAGED_RUNTIME_RECONFIGURATION',
    });
    await expect(safety.mutateWorkspace(block)).resolves.toEqual(blocked);

    await expect(safety.reserveOperation({
      sessionId: randomUUID(),
      operationClass: 'SESSION_READ',
      holderType: 'GATEWAY_SYNC',
      holderId: 'replacement-session-startup',
    })).resolves.toMatchObject({
      outcome: 'BLOCKED',
      reason: 'MANAGED_RUNTIME_RECONFIGURATION',
    });

    await expect(safety.mutateWorkspace({
      sessionId: INTEGRATION_SESSION_ID,
      operationType: 'OPENWA_WORKSPACE_RESUME',
      idempotencyKey: randomUUID(),
      requestHash: 'f'.repeat(64),
    })).resolves.toMatchObject({ status: 'READY' });
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM activity_events
       WHERE event_type IN ('openwa_safety.workspace_blocked', 'openwa_safety.workspace_resumed')
         AND session_id = $1`,
      [INTEGRATION_SESSION_ID],
    )).rows[0]?.count).toBe('2');
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

  it('settles a connector attempt from its durable safety snapshot after the lease row rolls over', async () => {
    const messageJobId = await createProcessingMessage('connector-safety-snapshot', INTEGRATION_GROUP_ID);
    const decision = await safety.reserveMessage({
      sessionId: INTEGRATION_SESSION_ID,
      messageJobId,
      recipientId: INTEGRATION_GROUP_ID,
      operationClass: 'MESSAGE_SEND_TEXT',
    });
    expect(decision.outcome).toBe('GRANTED');
    if (decision.outcome !== 'GRANTED') return;

    await pool.query(
      `INSERT INTO openwa_connector_sessions
         (session_id, desired_webhook_id, desired_connector_id, binding_generation, binding_synced_at,
          health_state, health_lease_expires_at)
       VALUES ($1, 'connector-webhook', $2, 1, now(), 'HEALTHY', now() + interval '10 minutes')`,
      [INTEGRATION_SESSION_ID, randomUUID()],
    );
    const attemptId = randomUUID();
    const commandId = randomUUID();
    const commandBody = Buffer.from('{"protocolVersion":1}', 'utf8');
    const payloadSha256 = createHash('sha256').update(commandBody).digest('hex');
    const committed = await safetyRepository.commitMessageStart(decision.permit, true, {
      attemptId,
      commandId,
      bindingGeneration: 1,
      payloadSha256,
      commandBody,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(committed).toMatchObject({ attemptId, commandId, bindingGeneration: 1 });
    expect((await pool.query(
      `SELECT safety_permit_token::text, safety_upstream_id, safety_policy_profile
       FROM message_attempts WHERE attempt_id = $1`,
      [attemptId],
    )).rows[0]).toEqual({
      safety_permit_token: decision.permit.permitToken,
      safety_upstream_id: decision.permit.upstreamId,
      safety_policy_profile: decision.permit.policyProfile,
    });

    const replacementLeaseToken = randomUUID();
    await pool.query(
      `UPDATE openwa_safety_leases SET lease_token = $2, holder_id = 'later-operation',
         lease_expires_at = now() + interval '10 minutes', updated_at = now()
       WHERE lane = 'ACTIVE_SESSION' AND session_id = $1`,
      [INTEGRATION_SESSION_ID, replacementLeaseToken],
    );

    await expect(database.transaction(client =>
      safetyRepository.recordMessageAttemptOutcomeWithClient(
        client,
        attemptId,
        { kind: 'AMBIGUOUS' },
      ))).resolves.toBe(true);
    expect((await pool.query(
      `SELECT outcome_kind FROM openwa_safety_outcome_receipts WHERE permit_token = $1`,
      [decision.permit.permitToken],
    )).rows[0]).toEqual({ outcome_kind: 'AMBIGUOUS' });
    expect((await pool.query(
      `SELECT lease_token::text FROM openwa_safety_leases
       WHERE lane = 'ACTIVE_SESSION' AND session_id = $1`,
      [INTEGRATION_SESSION_ID],
    )).rows[0]).toEqual({ lease_token: replacementLeaseToken });
  });

  it('corrects a sent connector attempt and its safety receipt when a later ack fails', async () => {
    const sent = await createSentConnectorMessage('late-ack-failure');
    expect((await pool.query(
      `SELECT status, last_error FROM message_jobs WHERE id = $1`,
      [sent.messageJobId],
    )).rows[0]).toEqual({ status: 'SENT', last_error: null });

    const failedEvidence = {
      ...sent.sentEvidence,
      eventId: randomUUID(),
      sequence: 2,
      kind: 'ACK_FAILED' as const,
      deliveryStatus: 'FAILED' as const,
      errorClass: 'TRANSIENT_FAILURE' as const,
      errorCode: 'OPENWA_DELIVERY_FAILED',
      occurredAt: new Date(Date.now() + 1_000).toISOString(),
    };
    await expect(sent.deliveryEvidence.project(failedEvidence)).resolves.toMatchObject({
      state: 'APPLIED', statusAdvanced: true, jobId: sent.messageJobId,
    });
    await expect(sent.deliveryEvidence.project(failedEvidence)).resolves.toMatchObject({
      state: 'APPLIED', statusAdvanced: false, jobId: sent.messageJobId,
    });

    expect((await pool.query(
      `SELECT status, last_error FROM message_jobs WHERE id = $1`,
      [sent.messageJobId],
    )).rows[0]).toEqual({
      status: 'FAILED',
      last_error: 'Connector ack failed: TRANSIENT_FAILURE: OPENWA_DELIVERY_FAILED',
    });
    expect((await pool.query(
      `SELECT transport_state, outcome FROM message_attempts WHERE attempt_id = $1`,
      [sent.attemptId],
    )).rows[0]).toEqual({ transport_state: 'FAILED_DEFINITIVE', outcome: 'FAILED' });
    expect((await pool.query(
      `SELECT outcome_kind FROM openwa_safety_outcome_receipts WHERE permit_token = $1`,
      [sent.permitToken],
    )).rows[0]).toEqual({ outcome_kind: 'TRANSIENT_FAILURE' });
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM openwa_safety_scopes
       WHERE consecutive_transient_failures = 1 AND success_streak = 0`,
    )).rows[0]?.count).toBe('3');
  });

  it('repairs connector ack failures ignored by an older Runtime release', async () => {
    const sent = await createSentConnectorMessage('legacy-late-ack-failure');
    const failedEventId = randomUUID();
    await pool.query(
      `UPDATE message_attempts SET last_evidence_sequence = 2, last_evidence_at = now()
       WHERE attempt_id = $1`,
      [sent.attemptId],
    );
    await pool.query(
      `INSERT INTO message_delivery_evidence
         (event_id, command_id, attempt_id, sequence, kind, openwa_message_id,
          delivery_status, error_class, error_code, binding_generation, plugin_version,
          occurred_at, payload_sha256, record_hash, projection_state)
       VALUES ($1,$2,$3,2,'ACK_FAILED',$4,'FAILED','TRANSIENT_FAILURE',
         'OPENWA_DELIVERY_FAILED',1,'integration-test',now(),$5,$6,'IGNORED')`,
      [failedEventId, sent.commandId, sent.attemptId, sent.sentEvidence.openwaMessageId,
        sent.payloadSha256, Buffer.alloc(32, 1)],
    );

    const migration = await readFile(
      resolve(process.cwd(), 'migrations/071_late_message_failure_reconciliation.sql'),
      'utf8',
    );
    await pool.query(migration);

    expect((await pool.query(
      `SELECT status, last_error FROM message_jobs WHERE id = $1`,
      [sent.messageJobId],
    )).rows[0]).toEqual({
      status: 'FAILED',
      last_error: 'Connector ack failed: TRANSIENT_FAILURE: OPENWA_DELIVERY_FAILED',
    });
    expect((await pool.query(
      `SELECT transport_state, outcome FROM message_attempts WHERE attempt_id = $1`,
      [sent.attemptId],
    )).rows[0]).toEqual({ transport_state: 'FAILED_DEFINITIVE', outcome: 'FAILED' });
    expect((await pool.query(
      `SELECT projection_state FROM message_delivery_evidence WHERE event_id = $1`,
      [failedEventId],
    )).rows[0]).toEqual({ projection_state: 'APPLIED' });
    expect((await pool.query(
      `SELECT outcome_kind FROM openwa_safety_outcome_receipts WHERE permit_token = $1`,
      [sent.permitToken],
    )).rows[0]).toEqual({ outcome_kind: 'TRANSIENT_FAILURE' });
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM openwa_safety_scopes
       WHERE consecutive_transient_failures = 1 AND success_streak = 0`,
    )).rows[0]?.count).toBe('3');
  });

  async function createSentConnectorMessage(key: string) {
    const messageJobId = await createProcessingMessage(key, INTEGRATION_GROUP_ID);
    const decision = await safety.reserveMessage({
      sessionId: INTEGRATION_SESSION_ID,
      messageJobId,
      recipientId: INTEGRATION_GROUP_ID,
      operationClass: 'MESSAGE_SEND_TEXT',
    });
    if (decision.outcome !== 'GRANTED') throw new Error('Expected a connector safety permit');
    await pool.query(
      `INSERT INTO openwa_connector_sessions
         (session_id, desired_webhook_id, desired_connector_id, binding_generation, binding_synced_at,
          health_state, health_lease_expires_at)
       VALUES ($1, 'late-ack-webhook', $2, 1, now(), 'HEALTHY', now() + interval '10 minutes')
       ON CONFLICT (session_id) DO UPDATE SET
         desired_webhook_id = EXCLUDED.desired_webhook_id,
         desired_connector_id = EXCLUDED.desired_connector_id,
         binding_generation = EXCLUDED.binding_generation,
         binding_synced_at = EXCLUDED.binding_synced_at,
         health_state = EXCLUDED.health_state,
         health_lease_expires_at = EXCLUDED.health_lease_expires_at`,
      [INTEGRATION_SESSION_ID, randomUUID()],
    );
    const attemptId = randomUUID();
    const commandId = randomUUID();
    const commandBody = Buffer.from('{"protocolVersion":1}', 'utf8');
    const payloadSha256 = createHash('sha256').update(commandBody).digest('hex');
    const committed = await safetyRepository.commitMessageStart(decision.permit, true, {
      attemptId, commandId, bindingGeneration: 1, payloadSha256, commandBody,
      expiresAt: new Date(Date.now() + 60_000),
    });
    if (!committed) throw new Error('Expected a committed connector attempt');
    const deliveryEvidence = new MessageDeliveryEvidenceService(database, safetyRepository);
    const sentEvidence = {
      protocolVersion: 1 as const,
      eventId: randomUUID(),
      commandId,
      attemptId,
      sessionId: INTEGRATION_SESSION_ID,
      sequence: 1,
      kind: 'ACK_SENT' as const,
      openwaMessageId: `late-ack-message-${randomUUID()}`,
      deliveryStatus: 'SENT' as const,
      errorClass: null,
      errorCode: null,
      bindingGeneration: 1,
      pluginVersion: 'integration-test',
      occurredAt: new Date().toISOString(),
      payloadSha256,
    };
    await pool.query(
      `UPDATE message_jobs SET last_error = 'Safety deferred: RATE_BUDGET' WHERE id = $1`,
      [messageJobId],
    );
    await deliveryEvidence.project(sentEvidence);
    return {
      messageJobId, attemptId, commandId, payloadSha256, sentEvidence, deliveryEvidence,
      permitToken: decision.permit.permitToken,
    };
  }

  async function createProcessingMessage(key: string, recipientId: string): Promise<string> {
    const messageJobId = await createQueuedMessage(key, recipientId);
    expect(await messages.markProcessing(messageJobId)).not.toBeNull();
    return messageJobId;
  }

  async function createQueuedMessage(
    key: string,
    recipientId: string,
    dryRun = true,
  ): Promise<string> {
    const text = `safety-${key}`;
    const created = await messages.create({
      idempotencyScope: 'openwa-safety-test',
      idempotencyKey: key,
      requestHash: messageRequestHash({
        sessionId: INTEGRATION_SESSION_ID,
        recipientId,
        text,
        scheduledAt: null,
        dryRun,
      }),
      sessionId: INTEGRATION_SESSION_ID,
      recipientId,
      text,
      scheduledAt: new Date(Date.now() - 1_000),
      dryRun,
    });
    await messages.claimDue(10);
    return created.job.id;
  }
});
