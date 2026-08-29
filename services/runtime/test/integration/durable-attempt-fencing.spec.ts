import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DatabaseService } from '../../src/core/database/database.service';
import { CampaignRunRepository } from '../../src/modules/campaigns/campaign-run.repository';
import { GatewayRepository } from '../../src/modules/gateway/gateway.repository';
import { GatewayGroupIntentRepository } from '../../src/modules/gateway/gateway-group-intent.repository';
import { ContactRepository } from '../../src/modules/contacts/contact.repository';
import { MessageJobRepository } from '../../src/modules/messages/message-job.repository';
import {
  INTEGRATION_GROUP_ID,
  INTEGRATION_SESSION_ID,
  integrationPool,
  resetIntegrationDatabase,
  seedSendableGroup,
} from '../support/integration-database';

describe('durable attempt fencing', () => {
  let pool: Pool;
  let database: DatabaseService;
  let gateway: GatewayRepository;
  let groupIntents: GatewayGroupIntentRepository;
  let campaigns: CampaignRunRepository;

  beforeAll(() => {
    pool = integrationPool();
    database = new DatabaseService();
    gateway = new GatewayRepository(database, new ContactRepository(database));
    groupIntents = new GatewayGroupIntentRepository(database);
    campaigns = new CampaignRunRepository(database, new MessageJobRepository(database));
  });
  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
    await seedSendableGroup(pool);
  });
  afterAll(async () => {
    await database.onApplicationShutdown();
    await pool.end();
  });

  it('prevents a stale campaign preparation from failing a reclaimed attempt', async () => {
    const campaign = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (session_id, name, payload)
       VALUES ($1, 'Fencing', '{"type":"TEXT","text":"hello"}') RETURNING id`,
      [INTEGRATION_SESSION_ID],
    );
    const run = await pool.query<{ id: string }>(
      `INSERT INTO campaign_runs
         (campaign_id, session_id, campaign_name_snapshot, idempotency_key, execution_mode,
          payload_snapshot, scheduled_at)
       VALUES ($1, $2, (SELECT name FROM campaigns WHERE id = $1),
         'fencing-run', 'DRY_RUN', '{"type":"TEXT","text":"hello"}', now()) RETURNING id`,
      [campaign.rows[0]!.id, INTEGRATION_SESSION_ID],
    );
    const runId = run.rows[0]!.id;
    const stale = await campaigns.claimPreparation(runId);
    expect(stale).not.toBeNull();
    await pool.query(
      `UPDATE campaign_runs SET preparation_lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [runId],
    );
    await campaigns.recoverExpiredPreparations();
    const current = await campaigns.claimPreparation(runId);
    expect(current).not.toBeNull();

    expect(await campaigns.failPreparationAttempt(
      runId,
      stale!.leaseToken,
      'stale failure',
    )).toBe('LOST_OWNERSHIP');
    expect(await campaigns.failPreparationAttempt(
      runId,
      current!.leaseToken,
      'current failure',
    )).toBe('PREPARING');
  });

  it('archives an ACTIVE campaign when recovery terminally fails its LIVE preparation', async () => {
    const campaign = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (session_id, name, payload, status)
       VALUES ($1, 'Recovery terminal', '{"type":"TEXT","text":"hello"}', 'ACTIVE') RETURNING id`,
      [INTEGRATION_SESSION_ID],
    );
    await pool.query(
      `INSERT INTO campaign_runs
         (campaign_id, session_id, campaign_name_snapshot, idempotency_key, execution_mode,
          payload_snapshot, scheduled_at, preparation_attempt_count, preparation_lease_token,
          preparation_lease_expires_at)
       VALUES ($1, $2, (SELECT name FROM campaigns WHERE id = $1),
         'terminal-recovery', 'LIVE', '{"type":"TEXT","text":"hello"}', now(), 3, gen_random_uuid(),
         now() - interval '1 second')`,
      [campaign.rows[0]!.id, INTEGRATION_SESSION_ID],
    );

    expect(await campaigns.recoverExpiredPreparations()).toBe(1);
    const state = await pool.query<{ campaign_status: string; run_status: string }>(
      `SELECT c.status AS campaign_status, cr.status AS run_status
       FROM campaigns c JOIN campaign_runs cr ON cr.campaign_id = c.id WHERE c.id = $1`,
      [campaign.rows[0]!.id],
    );
    expect(state.rows[0]).toEqual({ campaign_status: 'ARCHIVED', run_status: 'FAILED' });
  });

  it('prevents a stale capability refresh from failing a reclaimed attempt', async () => {
    const operation = await groupIntents.requestCapabilityRefresh(
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
    );
    const revision = operation!.requestRevision;
    const stale = await groupIntents.claim(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID);
    expect(stale).not.toBeNull();
    await pool.query(
      `UPDATE gateway_group_reconciliation_intents
       SET lease_expires_at = now() - interval '1 second'
       WHERE session_id = $1 AND group_id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    await pool.query(
      `UPDATE gateway_sync_rate_limits
       SET active_lease_expires_at = now() - interval '1 second'
       WHERE session_id = $1`,
      [INTEGRATION_SESSION_ID],
    );
    await groupIntents.recoverExpired();
    await pool.query(
      `UPDATE gateway_sync_rate_limits SET next_request_at = now()
       WHERE session_id = $1`,
      [INTEGRATION_SESSION_ID],
    );
    const current = await groupIntents.claim(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID);
    expect(current).not.toBeNull();

    expect(await groupIntents.fail(
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      stale!.leaseToken,
      revision,
      { retryable: true, ratePressure: false, code: 'STALE_FAILURE' },
    )).toBe('LOST_OWNERSHIP');
    expect(await groupIntents.fail(
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      current!.leaseToken,
      revision,
      { retryable: true, ratePressure: false, code: 'CURRENT_FAILURE' },
    )).toBe('RETRY');
  });

  it('terminates a non-retryable capability refresh failure immediately', async () => {
    const operation = await groupIntents.requestCapabilityRefresh(
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
    );
    const revision = operation!.requestRevision;
    const claim = await groupIntents.claim(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID);
    expect(claim).not.toBeNull();

    expect(await groupIntents.fail(
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      claim!.leaseToken,
      revision,
      { retryable: false, ratePressure: false, code: 'UPSTREAM_VALIDATION_ERROR' },
    )).toBe('FAILED');
    expect(await groupIntents.claim(
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
    )).toBeNull();
    expect(await groupIntents.findCapabilityRefresh(
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      revision,
    )).toMatchObject({ status: 'FAILED', errorCode: 'UPSTREAM_VALIDATION_ERROR' });
  });

  it('keeps capability refresh history stable while a newer revision runs', async () => {
    const first = await groupIntents.requestCapabilityRefresh(
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
    );
    const firstClaim = await groupIntents.claim(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID);
    expect(firstClaim).not.toBeNull();

    const second = await database.transaction(client => groupIntents.scheduleInTransaction(
      client,
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      'group.update',
      { immediate: true },
    ));
    expect(second.requestedRevision).toBe(first!.requestRevision + 1);
    expect(await groupIntents.findCapabilityRefresh(
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      first!.requestRevision,
    )).toMatchObject({ status: 'RUNNING', attemptCount: 1 });
    expect(await groupIntents.findCapabilityRefresh(
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      second.requestedRevision,
    )).toMatchObject({ status: 'PENDING', attemptCount: 0 });

    expect(await groupIntents.complete(
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      firstClaim!.leaseToken,
      first!.requestRevision,
    )).toBe('PENDING');
    const completedFirst = await groupIntents.findCapabilityRefresh(
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      first!.requestRevision,
    );
    expect(completedFirst).toMatchObject({ status: 'COMPLETED', errorCode: null });
    expect(completedFirst!.completedAt).toBeInstanceOf(Date);

    await pool.query(
      `UPDATE gateway_sync_rate_limits SET next_request_at = now()
       WHERE session_id = $1`,
      [INTEGRATION_SESSION_ID],
    );
    const secondClaim = await groupIntents.claim(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID);
    expect(secondClaim).not.toBeNull();
    expect(await groupIntents.fail(
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      secondClaim!.leaseToken,
      second.requestedRevision,
      { retryable: false, ratePressure: false, code: 'SECOND_REVISION_FAILED' },
    )).toBe('FAILED');

    expect(await groupIntents.findCapabilityRefresh(
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      first!.requestRevision,
    )).toMatchObject({
      status: 'COMPLETED',
      completedAt: completedFirst!.completedAt,
      errorCode: null,
    });
    expect(await groupIntents.findCapabilityRefresh(
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      second.requestedRevision,
    )).toMatchObject({ status: 'FAILED', errorCode: 'SECOND_REVISION_FAILED' });
  });

  it('suppresses capability refresh claims while a full session sync is running', async () => {
    await groupIntents.requestCapabilityRefresh(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID);
    const run = await gateway.createSyncRun(INTEGRATION_SESSION_ID);

    expect(await groupIntents.listDispatchable(10)).toEqual([]);
    expect(await groupIntents.claim(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID)).toBeNull();

    const syncClaim = await gateway.claimSyncRun(run.id);
    expect(syncClaim).not.toBeNull();

    expect(await groupIntents.listDispatchable(10)).toEqual([]);
    expect(await groupIntents.claim(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID)).toBeNull();

    expect(await gateway.completeSyncRun(run.id, syncClaim!.leaseToken, 0, 0)).toBe(true);
    expect(await groupIntents.listDispatchable(10)).toHaveLength(1);
    expect(await groupIntents.claim(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID)).not.toBeNull();
  });
});
