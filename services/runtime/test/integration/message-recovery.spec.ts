import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { runtimeConfig } from '../../src/core/config/runtime-config';
import { DatabaseService } from '../../src/core/database/database.service';
import { OpenWAClient, OpenWAHttpError } from '../../src/integrations/openwa/openwa.client';
import { OpenWASafetyGovernorService } from '../../src/integrations/openwa/safety/openwa-safety-governor.service';
import { OpenWASafetyRepository } from '../../src/integrations/openwa/safety/openwa-safety.repository';
import { GatewayRepository } from '../../src/modules/gateway/gateway.repository';
import { ContactRepository } from '../../src/modules/contacts/contact.repository';
import { SessionScopeService } from '../../src/modules/gateway/session-scope.service';
import { messageRequestHash } from '../../src/modules/messages/message-idempotency';
import { MessageJobProcessorService } from '../../src/modules/messages/message-job-processor.service';
import { MessageJobRepository } from '../../src/modules/messages/message-job.repository';
import { MessageSendPolicyService } from '../../src/modules/messages/message-send-policy.service';
import { OutboundSessionLeaseRepository } from '../../src/modules/messages/outbound-session-lease.repository';
import { OutboundSessionLeaseService } from '../../src/modules/messages/outbound-session-lease.service';
import { INTEGRATION_GROUP_ID, INTEGRATION_SESSION_ID, integrationPool, resetIntegrationDatabase, seedSendableGroup } from '../support/integration-database';

describe('message durability and delivery', () => {
  let pool: Pool;
  let database: DatabaseService;
  let messages: MessageJobRepository;
  let outboundSessions: OutboundSessionLeaseService;
  const safetyFor = (database: DatabaseService) => new OpenWASafetyGovernorService(
    new OpenWASafetyRepository(database),
  );

  beforeAll(() => {
    pool = integrationPool();
    database = new DatabaseService();
    messages = new MessageJobRepository(database);
    outboundSessions = new OutboundSessionLeaseService(
      new OutboundSessionLeaseRepository(database),
      messages,
    );
  });

  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
    await seedSendableGroup(pool);
  });

  afterAll(async () => {
    await database.onApplicationShutdown();
    await pool.end();
  });

  const create = (
    key: string,
    text: string,
    dryRun = true,
    sessionId = INTEGRATION_SESSION_ID,
    recipientId = INTEGRATION_GROUP_ID,
  ) => messages.create({
    idempotencyScope: 'runtime-api', idempotencyKey: key,
    requestHash: messageRequestHash({
      sessionId, recipientId, text, scheduledAt: null, dryRun,
    }),
    sessionId, recipientId,
    text, scheduledAt: new Date(Date.now() - 1_000), dryRun,
  });

  it('binds an idempotency key to one request fingerprint', async () => {
    const first = await create('same-intent', 'hello');
    const repeated = await create('same-intent', 'hello');
    const conflicting = await create('same-intent', 'different');

    expect(first.created).toBe(true);
    expect(repeated).toMatchObject({ created: false, idempotencyConflict: false });
    expect(repeated.job.id).toBe(first.job.id);
    expect(conflicting).toMatchObject({ created: false, idempotencyConflict: true });
  });

  it('lets concurrent scheduler claims take disjoint rows', async () => {
    for (let index = 0; index < 20; index += 1) await create(`concurrent-${index}`, `message-${index}`);

    const [first, second] = await Promise.all([messages.claimDue(10), messages.claimDue(10)]);
    const ids = [...first, ...second].map(job => job.id);

    expect(first).toHaveLength(10);
    expect(second).toHaveLength(10);
    expect(new Set(ids).size).toBe(20);
  });

  it('claims at most one live job per session across concurrent schedulers', async () => {
    const first = await create('live-lane-first', 'first', false);
    const second = await create('live-lane-second', 'second', false);

    const claims = await Promise.all([messages.claimDue(10), messages.claimDue(10)]);
    const claimed = claims.flat();
    expect(claimed).toHaveLength(1);
    expect([first.job.id, second.job.id]).toContain(claimed[0]!.id);
    expect((await pool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM message_jobs
       WHERE id = ANY($1::uuid[]) GROUP BY status ORDER BY status`,
      [[first.job.id, second.job.id]],
    )).rows).toEqual([
      { status: 'SCHEDULED', count: '1' },
      { status: 'QUEUED', count: '1' },
    ]);

    expect(await messages.markProcessing(claimed[0]!.id)).not.toBeNull();
    await pool.query(
      `UPDATE message_jobs SET status = 'ACCEPTED', lease_expires_at = NULL, updated_at = now()
       WHERE id = $1`,
      [claimed[0]!.id],
    );
    const next = await messages.claimDue(10);
    expect(next).toHaveLength(1);
    expect(next[0]!.id).not.toBe(claimed[0]!.id);
  });

  it('allows one live job from each session to progress concurrently', async () => {
    const secondSessionId = randomUUID();
    await seedSendableGroup(pool, secondSessionId);
    const first = await create('live-session-first', 'first', false);
    const second = await create(
      'live-session-second',
      'second',
      false,
      secondSessionId,
    );

    const claimed = await messages.claimDue(10);
    expect(new Set(claimed.map(job => job.sessionId))).toEqual(new Set([
      INTEGRATION_SESSION_ID,
      secondSessionId,
    ]));
    expect(new Set(claimed.map(job => job.id))).toEqual(new Set([first.job.id, second.job.id]));
  });

  it('wakes a session-lease deferral as soon as the safety lane is released', async () => {
    const holder = await create('live-lease-holder', 'lease holder', false);
    expect((await messages.claimDue(10)).map(job => job.id)).toEqual([holder.job.id]);
    expect(await messages.markProcessing(holder.job.id)).not.toBeNull();
    const safety = safetyFor(database);
    const decision = await safety.reserveMessage({
      sessionId: INTEGRATION_SESSION_ID,
      messageJobId: holder.job.id,
      recipientId: INTEGRATION_GROUP_ID,
      operationClass: 'MESSAGE_SEND_TEXT',
    });
    expect(decision.outcome).toBe('GRANTED');
    if (decision.outcome !== 'GRANTED') return;

    const created = await create('live-early-wake', 'wake after release', false);
    await pool.query(
      `UPDATE message_jobs
       SET scheduled_at = now() + interval '15 minutes',
         defer_reason = 'SESSION_OPERATION_IN_FLIGHT'
       WHERE id = $1`,
      [created.job.id],
    );
    await pool.query(
      `UPDATE message_jobs SET status = 'ACCEPTED', lease_expires_at = NULL, updated_at = now()
       WHERE id = $1`,
      [holder.job.id],
    );

    await expect(messages.claimDue(10)).resolves.toEqual([]);
    await safety.release(decision.permit);
    await expect(messages.claimDue(10)).resolves.toMatchObject([
      { id: created.job.id, status: 'QUEUED' },
    ]);
  });

  it('turns an expired PROCESSING lease into audited UNKNOWN state', async () => {
    const created = await create('expired-send', 'hello', false);
    await messages.claimDue(10);
    await messages.markProcessing(created.job.id);
    await pool.query(
      `UPDATE message_jobs SET lease_expires_at = now() - interval '1 second',
         current_upstream_started_at = now() - interval '2 seconds', attempt_count = 1
       WHERE id = $1`,
      [created.job.id],
    );

    expect(await messages.markExpiredProcessingUnknown()).toBe(1);
    expect(await messages.find(created.job.id)).toMatchObject({
      status: 'UNKNOWN', lastError: 'Processing lease expired; delivery outcome is unknown',
    });
    const attempt = await pool.query(
      'SELECT outcome, error FROM message_attempts WHERE message_job_id = $1', [created.job.id],
    );
    expect(attempt.rows[0]).toMatchObject({
      outcome: 'UNKNOWN', error: 'Processing lease expired; delivery outcome is unknown',
    });
  });

  it('safely reschedules an expired PROCESSING lease before the upstream boundary', async () => {
    const created = await create('expired-before-send', 'hello', false);
    await messages.claimDue(10);
    await messages.markProcessing(created.job.id);
    await pool.query(
      `UPDATE message_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [created.job.id],
    );

    expect(await messages.markExpiredProcessingUnknown()).toBe(0);
    expect(await messages.find(created.job.id)).toMatchObject({
      status: 'SCHEDULED', lastError: 'Recovered processing job before upstream start',
      attemptCount: 0,
    });
    expect((await pool.query(
      'SELECT 1 FROM message_attempts WHERE message_job_id = $1', [created.job.id],
    )).rowCount).toBe(0);
  });

  it('sends through fake OpenWA and persists ACCEPTED with the upstream message ID', async () => {
    const created = await create('accepted-send', 'integration-success', false);
    await messages.claimDue(10);
    const gateway = new GatewayRepository(database, new ContactRepository(database));
    const processor = new MessageJobProcessorService(
      database, messages,
      new MessageSendPolicyService(gateway, new SessionScopeService()),
      new OpenWAClient(), gateway, outboundSessions,
      undefined, undefined, undefined, undefined, undefined, safetyFor(database),
    );

    const result = await processor.process({ messageJobId: created.job.id }) as { messageId: string };

    expect(result.messageId).toMatch(/^fake-/);
    expect(await messages.find(created.job.id)).toMatchObject({ status: 'ACCEPTED', openwaMessageId: result.messageId });
  });

  it('records a proven 403 failure and schedules a high-priority stale capability refresh', async () => {
    const created = await create('denied-send', 'simulate-403', false);
    await messages.claimDue(10);
    const gateway = new GatewayRepository(database, new ContactRepository(database));
    const processor = new MessageJobProcessorService(
      database, messages,
      new MessageSendPolicyService(gateway, new SessionScopeService()),
      new OpenWAClient(), gateway, outboundSessions,
      undefined, undefined, undefined, undefined, undefined, safetyFor(database),
    );

    await expect(processor.process({ messageJobId: created.job.id })).rejects.toBeInstanceOf(OpenWAHttpError);
    expect(await messages.find(created.job.id)).toMatchObject({ status: 'FAILED' });
    expect(await gateway.findGroup(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID)).toMatchObject({
      sendCapability: { status: 'ALLOWED', reason: 'SEND_ALLOWED', invalidatedAt: expect.any(Date) },
    });
    expect((await pool.query(
      `SELECT reasons, priority FROM gateway_group_reconciliation_intents
       WHERE session_id = $1 AND group_id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    )).rows[0]).toMatchObject({ reasons: ['send.permission_denied'], priority: 1 });
  });

  it('records a proven 404 failure and schedules a high-priority group reconciliation', async () => {
    const created = await create('missing-group-send', 'simulate-404', false);
    await messages.claimDue(10);
    const gateway = new GatewayRepository(database, new ContactRepository(database));
    const processor = new MessageJobProcessorService(
      database, messages,
      new MessageSendPolicyService(gateway, new SessionScopeService()),
      new OpenWAClient(), gateway, outboundSessions,
      undefined, undefined, undefined, undefined, undefined, safetyFor(database),
    );

    await expect(processor.process({ messageJobId: created.job.id })).rejects.toMatchObject({ status: 404 });
    expect(await messages.find(created.job.id)).toMatchObject({ status: 'FAILED' });
    expect(await gateway.findGroup(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID)).toMatchObject({
      sendCapability: { status: 'ALLOWED', reason: 'SEND_ALLOWED', invalidatedAt: expect.any(Date) },
    });
    expect((await pool.query(
      `SELECT reasons, priority FROM gateway_group_reconciliation_intents
       WHERE session_id = $1 AND group_id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    )).rows[0]).toMatchObject({ reasons: ['send.group_not_found'], priority: 1 });
  });

  it('rechecks live policy after acquiring the session lease and before dispatch', async () => {
    const created = await create('late-session-block', 'must-not-send', false);
    await messages.claimDue(10);
    const gateway = new GatewayRepository(database, new ContactRepository(database));
    const openwa = {
      sendText: vi.fn().mockResolvedValue({ messageId: 'must-not-exist', timestamp: Date.now() }),
    } as unknown as OpenWAClient;
    const safety = safetyFor(database);
    const reserve = safety.reserveMessage.bind(safety);
    vi.spyOn(safety, 'reserveMessage').mockImplementation(async input => {
      const decision = await reserve(input);
      if (decision.outcome === 'GRANTED') {
        await pool.query(
          `UPDATE gateway_sessions SET status = 'disconnected', updated_at = now() WHERE id = $1`,
          [INTEGRATION_SESSION_ID],
        );
      }
      return decision;
    });
    const processor = new MessageJobProcessorService(
      database,
      messages,
      new MessageSendPolicyService(gateway, new SessionScopeService()),
      openwa,
      gateway,
      outboundSessions,
      {
        ...runtimeConfig(),
        ALLOW_LIVE_SENDS: true,
        OUTBOUND_MIN_DELAY_MS: 0,
        OUTBOUND_MAX_DELAY_MS: 0,
      },
      undefined, undefined, undefined, undefined, safety,
    );

    await expect(processor.process({ messageJobId: created.job.id }))
      .resolves.toMatchObject({ safetyDeferred: true, reason: 'FINAL_SEND_FENCE_REJECTED' });
    expect(openwa.sendText).not.toHaveBeenCalled();
    expect(await messages.find(created.job.id)).toMatchObject({
      status: 'SCHEDULED',
      lastError: 'Final send fence rejected current session, recipient, campaign, or cancellation state',
    });
  });

  it('records UNKNOWN when the connection drops after the upstream request starts', async () => {
    const created = await create('ambiguous-send', 'simulate-network-drop', false);
    await messages.claimDue(10);
    const gateway = new GatewayRepository(database, new ContactRepository(database));
    const processor = new MessageJobProcessorService(
      database, messages,
      new MessageSendPolicyService(gateway, new SessionScopeService()),
      new OpenWAClient(), gateway, outboundSessions,
      undefined, undefined, undefined, undefined, undefined, safetyFor(database),
    );

    await expect(processor.process({ messageJobId: created.job.id })).rejects.toBeInstanceOf(Error);
    expect(await messages.find(created.job.id)).toMatchObject({ status: 'UNKNOWN' });
    const attempts = await pool.query<{ outcome: string }>(
      'SELECT outcome FROM message_attempts WHERE message_job_id = $1', [created.job.id],
    );
    expect(attempts.rows).toEqual([{ outcome: 'UNKNOWN' }]);
  });

  it.each([
    ['an upstream 5xx', 'simulate-500'],
    ['an upstream request timeout', 'simulate-408'],
  ])('records UNKNOWN for %s after dispatch starts', async (_case, text) => {
    const created = await create(`ambiguous-${text}`, text, false);
    await messages.claimDue(10);
    const gateway = new GatewayRepository(database, new ContactRepository(database));
    const processor = new MessageJobProcessorService(
      database, messages,
      new MessageSendPolicyService(gateway, new SessionScopeService()),
      new OpenWAClient(), gateway, outboundSessions,
      undefined, undefined, undefined, undefined, undefined, safetyFor(database),
    );

    await expect(processor.process({ messageJobId: created.job.id })).rejects.toBeInstanceOf(OpenWAHttpError);
    expect(await messages.find(created.job.id)).toMatchObject({ status: 'UNKNOWN' });
    const attempts = await pool.query<{ outcome: string }>(
      'SELECT outcome FROM message_attempts WHERE message_job_id = $1', [created.job.id],
    );
    expect(attempts.rows).toEqual([{ outcome: 'UNKNOWN' }]);
  });
});
