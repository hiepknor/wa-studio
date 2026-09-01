import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { DatabaseService } from '../../src/core/database/database.service';
import { runtimeConfig } from '../../src/core/config/runtime-config';
import { MessageStatusProjectionService } from '../../src/modules/messages/message-status-projection.service';
import { MessageJobRepository } from '../../src/modules/messages/message-job.repository';
import { RuntimeEventRepository } from '../../src/modules/webhooks/runtime-event.repository';
import { GatewayGroupIntentRepository } from '../../src/modules/gateway/gateway-group-intent.repository';
import { GatewaySyncRateLimitRepository } from '../../src/modules/gateway/gateway-sync-rate-limit.repository';
import { GatewayRepository } from '../../src/modules/gateway/gateway.repository';
import { ContactRepository } from '../../src/modules/contacts/contact.repository';
import { ContactMessageObserverService } from '../../src/modules/contacts/contact-message-observer.service';
import { ContactMessageObservationIntentRepository } from '../../src/modules/contacts/contact-message-observation-intent.repository';
import { ContactMessageObservationTick } from '../../src/modules/contacts/contact-message-observation.tick';
import { GatewaySyncItemRepository } from '../../src/modules/gateway/gateway-sync-item.repository';
import { GatewaySyncService } from '../../src/modules/gateway/gateway-sync.service';
import type { OpenWAClient } from '../../src/integrations/openwa/openwa.client';
import { WebhookProcessorService } from '../../src/modules/webhooks/webhook-processor.service';
import { WebhookRepository, type OpenWAWebhookEnvelope } from '../../src/modules/webhooks/webhook.repository';
import { INTEGRATION_GROUP_ID, INTEGRATION_SESSION_ID, integrationPool, resetIntegrationDatabase, seedSendableGroup } from '../support/integration-database';

describe('durable webhook processing', () => {
  let pool: Pool;
  let database: DatabaseService;
  let webhooks: WebhookRepository;

  beforeAll(() => {
    pool = integrationPool();
    database = new DatabaseService();
    webhooks = new WebhookRepository(database, {
      ...runtimeConfig(),
      RUNTIME_COMPACT_PROCESSED_WEBHOOK_PAYLOAD_ENABLED: true,
    });
  });

  beforeEach(() => resetIntegrationDatabase(pool));

  afterAll(async () => {
    await database.onApplicationShutdown();
    await pool.end();
  });

  it('normalizes a durable envelope and marks it processed', async () => {
    const envelope: OpenWAWebhookEnvelope = {
      event: 'message.received', timestamp: '2026-08-11T00:00:00.000Z',
      sessionId: INTEGRATION_SESSION_ID, idempotencyKey: 'webhook-event-1', deliveryId: 'delivery-1',
      data: {
        id: 'message-1', chatId: INTEGRATION_GROUP_ID, author: '84970000000@c.us', body: 'hello',
        type: 'text', fromMe: false, isGroup: true,
      },
    };
    const runtimeEvents = new RuntimeEventRepository(
      database,
      new GatewayGroupIntentRepository(database),
      { ...runtimeConfig(), RUNTIME_COMPACT_EVENT_PAYLOAD_ENABLED: true },
    );
    const processor = new WebhookProcessorService(
      database,
      webhooks,
      runtimeEvents,
      new MessageStatusProjectionService(database),
      new ContactMessageObserverService(
        new ContactRepository(database),
        new ContactMessageObservationIntentRepository(database),
        true,
      ),
    );

    expect(await webhooks.insert(envelope)).toBe(true);
    await processor.process(envelope.idempotencyKey);

    const stored = await pool.query<{
      processing_state: string;
      raw_payload: Record<string, unknown>;
      event_type: string;
      event_version: number;
      event_payload: Record<string, unknown>;
      body: string;
    }>(
      `SELECT we.processing_state, we.payload AS raw_payload, re.event_type, re.event_version,
         re.payload AS event_payload, im.body
       FROM webhook_events we
       JOIN runtime_events re ON re.event_id = we.idempotency_key
       JOIN inbound_messages im ON im.event_id = re.event_id
       WHERE we.idempotency_key = $1`,
      [envelope.idempotencyKey],
    );
    expect(stored.rows[0]).toMatchObject({
      processing_state: 'PROCESSED',
      raw_payload: { event: 'message.received', data: {} },
      event_type: 'message.received',
      event_version: 2,
      body: 'hello',
    });
    expect(stored.rows[0]!.event_payload).not.toHaveProperty('body');
    expect(stored.rows[0]!.event_payload).toMatchObject({ bodyBytes: 5 });
  });

  it('projects an OpenWA message status only inside the owning session', async () => {
    const otherSessionId = '00000000-0000-4000-8000-000000000099';
    const openwaMessageId = 'shared-openwa-message';
    const jobs = await pool.query<{ id: string; session_id: string }>(
      `INSERT INTO message_jobs
         (idempotency_scope, idempotency_key, request_hash, session_id, recipient_id,
          payload, scheduled_at, status, dry_run, openwa_message_id)
       VALUES
         ('test', 'session-one', 'hash-one', $1, 'one@g.us', '{"type":"TEXT","text":"one"}', now(),
          'ACCEPTED', false, $3),
         ('test', 'session-two', 'hash-two', $2, 'two@g.us', '{"type":"TEXT","text":"two"}', now(),
          'ACCEPTED', false, $3)
       RETURNING id, session_id`,
      [INTEGRATION_SESSION_ID, otherSessionId, openwaMessageId],
    );
    const envelope: OpenWAWebhookEnvelope = {
      event: 'message.ack', timestamp: '2026-08-11T00:00:00.000Z',
      sessionId: INTEGRATION_SESSION_ID, idempotencyKey: 'session-scoped-status',
      deliveryId: 'session-scoped-delivery', data: { messageId: openwaMessageId, status: 'delivered' },
    };
    const projections = new MessageStatusProjectionService(database);
    const processor = new WebhookProcessorService(
      database,
      webhooks,
      new RuntimeEventRepository(database, new GatewayGroupIntentRepository(database)),
      projections,
      new ContactMessageObserverService(
        new ContactRepository(database),
        new ContactMessageObservationIntentRepository(database),
        true,
      ),
    );

    await webhooks.insert(envelope);
    expect(await processor.process(envelope.idempotencyKey)).toEqual({
      statusUpdated: true,
      projectionPending: false,
    });

    const states = await pool.query<{ id: string; session_id: string; status: string }>(
      `SELECT id, session_id, status FROM message_jobs ORDER BY session_id`,
    );
    expect(states.rows).toEqual([
      { ...jobs.rows.find(job => job.session_id === INTEGRATION_SESSION_ID)!, status: 'DELIVERED' },
      { ...jobs.rows.find(job => job.session_id === otherSessionId)!, status: 'ACCEPTED' },
    ]);
    const projection = await pool.query<{ projection_state: string; projected_job_id: string }>(
      `SELECT projection_state, projected_job_id FROM message_events WHERE event_id = $1`,
      [envelope.idempotencyKey],
    );
    expect(projection.rows[0]).toEqual({
      projection_state: 'APPLIED',
      projected_job_id: jobs.rows.find(job => job.session_id === INTEGRATION_SESSION_ID)!.id,
    });
  });

  it('reconciles a callback that arrives before the OpenWA message id is bound', async () => {
    const openwaMessageId = 'early-openwa-message';
    const job = await pool.query<{ id: string }>(
      `INSERT INTO message_jobs
         (idempotency_scope, idempotency_key, request_hash, session_id, recipient_id,
          payload, scheduled_at, status, dry_run, attempt_count)
       VALUES ('test', 'early-callback', 'early-hash', $1, 'early@g.us',
         '{"type":"TEXT","text":"early"}', now(), 'PROCESSING', false, 1)
       RETURNING id`,
      [INTEGRATION_SESSION_ID],
    );
    const envelope: OpenWAWebhookEnvelope = {
      event: 'message.ack', timestamp: '2026-08-11T00:00:00.000Z',
      sessionId: INTEGRATION_SESSION_ID, idempotencyKey: 'early-status-event',
      deliveryId: 'early-status-delivery', data: { messageId: openwaMessageId, status: 'delivered' },
    };
    const projections = new MessageStatusProjectionService(database);
    const processor = new WebhookProcessorService(
      database,
      webhooks,
      new RuntimeEventRepository(database, new GatewayGroupIntentRepository(database)),
      projections,
      new ContactMessageObserverService(
        new ContactRepository(database),
        new ContactMessageObservationIntentRepository(database),
        true,
      ),
    );

    await webhooks.insert(envelope);
    expect(await processor.process(envelope.idempotencyKey)).toEqual({
      statusUpdated: false,
      projectionPending: true,
    });
    expect((await pool.query<{ projection_state: string }>(
      `SELECT projection_state FROM message_events WHERE event_id = $1`,
      [envelope.idempotencyKey],
    )).rows[0]?.projection_state).toBe('PENDING');

    const messages = new MessageJobRepository(database);
    await database.transaction(async client => {
      await messages.updateResult(client, job.rows[0]!.id, 'ACCEPTED', { openwaMessageId });
      expect(await projections.reconcilePendingForJobInTransaction(client, job.rows[0]!.id)).toBe(1);
    });

    expect((await pool.query<{ status: string }>(
      `SELECT status FROM message_jobs WHERE id = $1`, [job.rows[0]!.id],
    )).rows[0]?.status).toBe('DELIVERED');
    expect((await pool.query<{ projection_state: string }>(
      `SELECT projection_state FROM message_events WHERE event_id = $1`,
      [envelope.idempotencyKey],
    )).rows[0]?.projection_state).toBe('APPLIED');
  });

  it('repairs a pending projection left behind across independent commits', async () => {
    const openwaMessageId = 'repair-openwa-message';
    const eventId = 'repair-status-event';
    const runtimeEvents = new RuntimeEventRepository(database, new GatewayGroupIntentRepository(database));
    await runtimeEvents.store({
      eventId,
      sourceEventType: 'message.ack',
      eventType: 'message.ack',
      eventVersion: 1,
      sessionId: INTEGRATION_SESSION_ID,
      occurredAt: new Date('2026-08-11T00:00:00.000Z'),
      payload: { messageId: openwaMessageId, groupId: null, deliveryStatus: 'read' },
    });
    const job = await pool.query<{ id: string }>(
      `INSERT INTO message_jobs
         (idempotency_scope, idempotency_key, request_hash, session_id, recipient_id,
          payload, scheduled_at, status, dry_run, openwa_message_id)
       VALUES ('test', 'repair-callback', 'repair-hash', $1, 'repair@g.us',
         '{"type":"TEXT","text":"repair"}', now(), 'ACCEPTED', false, $2)
       RETURNING id`,
      [INTEGRATION_SESSION_ID, openwaMessageId],
    );
    const projections = new MessageStatusProjectionService(database);

    expect(await projections.repairPending()).toBe(1);
    expect((await pool.query<{ status: string }>(
      `SELECT status FROM message_jobs WHERE id = $1`, [job.rows[0]!.id],
    )).rows[0]?.status).toBe('READ');
    expect((await pool.query<{ projection_state: string }>(
      `SELECT projection_state FROM message_events WHERE event_id = $1`, [eventId],
    )).rows[0]?.projection_state).toBe('APPLIED');
  });

  it('enriches a synchronized member from message push-name evidence without storing raw contact data', async () => {
    await seedSendableGroup(pool);
    const memberId = '84970000000@c.us';
    await pool.query(
      `INSERT INTO group_members
         (session_id, group_id, participant_id, phone_number, is_admin, is_super_admin)
       VALUES ($1, $2, $3, '84970000000', false, false)`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, memberId],
    );
    const contacts = new ContactRepository(database);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await contacts.seedGroupMembers(client, INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, [{
        id: memberId, number: '84970000000', name: null, isAdmin: false, isSuperAdmin: false,
      }]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const envelope: OpenWAWebhookEnvelope = {
      event: 'message.received', timestamp: '2026-08-11T00:00:00.000Z',
      sessionId: INTEGRATION_SESSION_ID, idempotencyKey: 'contact-event', deliveryId: 'contact-delivery',
      data: {
        id: 'message-contact', chatId: INTEGRATION_GROUP_ID, author: memberId, body: 'hello',
        type: 'text', fromMe: false, isGroup: true,
        contact: { pushName: 'Observed sender', privateField: 'must not persist' },
      },
    };
    const runtimeEvents = new RuntimeEventRepository(
      database,
      new GatewayGroupIntentRepository(database),
    );
    const observationIntents = new ContactMessageObservationIntentRepository(database);
    const observer = new ContactMessageObserverService(
      contacts,
      observationIntents,
      true,
    );
    const processor = new WebhookProcessorService(
      database, webhooks, runtimeEvents,
      new MessageStatusProjectionService(database),
      observer,
    );

    await webhooks.insert(envelope);
    await processor.process(envelope.idempotencyKey);
    await new ContactMessageObservationTick(observationIntents, observer, {
      enabled: true,
      maxPerTick: 100,
    }).run();

    const member = await pool.query<{ display_name: string; display_name_source: string }>(
      `SELECT display_name, display_name_source FROM group_members
       WHERE session_id = $1 AND group_id = $2 AND participant_id = $3`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, memberId],
    );
    expect(member.rows[0]).toEqual({
      display_name: 'Observed sender', display_name_source: 'OPENWA_PUSH_NAME',
    });
    const runtimeEvent = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM runtime_events WHERE event_id = $1`, [envelope.idempotencyKey],
    );
    expect(JSON.stringify(runtimeEvent.rows[0]?.payload)).not.toContain('Observed sender');
    expect(JSON.stringify(runtimeEvent.rows[0]?.payload)).not.toContain('privateField');
    expect(await pool.query('SELECT 1 FROM contact_message_observation_intents')).toHaveProperty('rowCount', 0);
  });

  it('rolls back projections and preserves raw payload when the atomic commit fails', async () => {
    const envelope: OpenWAWebhookEnvelope = {
      event: 'message.ack', timestamp: '2026-08-11T00:00:00.000Z',
      sessionId: INTEGRATION_SESSION_ID, idempotencyKey: 'atomic-failure', deliveryId: 'atomic-delivery',
      data: { id: 'outbound-message', status: 'delivered', body: 'raw evidence' },
    };
    const runtimeEvents = new RuntimeEventRepository(
      database,
      new GatewayGroupIntentRepository(database),
    );
    const processor = new WebhookProcessorService(
      database,
      webhooks,
      runtimeEvents,
      {
        projectEventInTransaction: vi.fn().mockRejectedValue(new Error('projection unavailable')),
      } as unknown as MessageStatusProjectionService,
      new ContactMessageObserverService(
        new ContactRepository(database),
        new ContactMessageObservationIntentRepository(database),
        true,
      ),
    );

    await webhooks.insert(envelope);
    await expect(processor.process(envelope.idempotencyKey)).rejects.toThrow('projection unavailable');

    const state = await pool.query<{
      processing_state: string;
      payload: OpenWAWebhookEnvelope;
      runtime_event_exists: boolean;
    }>(
      `SELECT webhook.processing_state, webhook.payload,
         EXISTS (SELECT 1 FROM runtime_events event WHERE event.event_id = webhook.idempotency_key)
           AS runtime_event_exists
       FROM webhook_events webhook WHERE webhook.idempotency_key = $1`,
      [envelope.idempotencyKey],
    );
    expect(state.rows[0]).toEqual({
      processing_state: 'RETRY',
      payload: envelope,
      runtime_event_exists: false,
    });
  });

  it('recovers an expired lease and eventually dead-letters a poison event', async () => {
    const envelope: OpenWAWebhookEnvelope = {
      event: 'unknown.event', timestamp: '2026-08-11T00:00:00.000Z',
      sessionId: INTEGRATION_SESSION_ID, idempotencyKey: 'poison-event', deliveryId: 'delivery-2', data: {},
    };
    await webhooks.insert(envelope);
    const firstClaim = await webhooks.claimForProcessing(envelope.idempotencyKey);
    expect(firstClaim?.envelope).toEqual(envelope);
    await pool.query(
      `UPDATE webhook_events SET lease_expires_at = now() - interval '1 second'
       WHERE idempotency_key = $1`,
      [envelope.idempotencyKey],
    );

    expect(await webhooks.recoverExpiredProcessing()).toBe(1);
    expect(await webhooks.listDispatchable(10)).toContainEqual({ idempotencyKey: envelope.idempotencyKey });

    const secondClaim = await webhooks.claimForProcessing(envelope.idempotencyKey);
    expect(secondClaim).not.toBeNull();
    await pool.query('UPDATE webhook_events SET attempt_count = 5 WHERE idempotency_key = $1', [envelope.idempotencyKey]);
    expect(await webhooks.markFailed(
      envelope.idempotencyKey,
      secondClaim!.leaseToken,
      'invalid payload',
    )).toBe('DEAD');
    const state = await pool.query<{
      processing_state: string;
      processing_error: string;
      dead_at: Date;
      payload: OpenWAWebhookEnvelope;
    }>(
      `SELECT processing_state, processing_error, dead_at, payload
       FROM webhook_events WHERE idempotency_key = $1`,
      [envelope.idempotencyKey],
    );
    expect(state.rows[0]).toMatchObject({ processing_state: 'DEAD', processing_error: 'invalid payload' });
    expect(state.rows[0]!.dead_at).toBeInstanceOf(Date);
    expect(state.rows[0]!.payload).toEqual(envelope);
  });

  it('fences a stale attempt after the event is reclaimed', async () => {
    const envelope: OpenWAWebhookEnvelope = {
      event: 'session.status', timestamp: '2026-08-11T00:00:00.000Z',
      sessionId: INTEGRATION_SESSION_ID, idempotencyKey: 'fenced-webhook',
      deliveryId: 'delivery-fenced', data: { status: 'ready' },
    };
    await webhooks.insert(envelope);
    const stale = await webhooks.claimForProcessing(envelope.idempotencyKey);
    expect(stale).not.toBeNull();
    await pool.query(
      `UPDATE webhook_events SET lease_expires_at = now() - interval '1 second'
       WHERE idempotency_key = $1`,
      [envelope.idempotencyKey],
    );
    await webhooks.recoverExpiredProcessing();
    const current = await webhooks.claimForProcessing(envelope.idempotencyKey);
    expect(current).not.toBeNull();
    expect(current!.leaseToken).not.toBe(stale!.leaseToken);

    expect(await webhooks.markProcessed(envelope.idempotencyKey, stale!.leaseToken)).toBe(false);
    expect(await webhooks.markFailed(
      envelope.idempotencyKey,
      stale!.leaseToken,
      'stale failure',
    )).toBe('LOST_OWNERSHIP');
    expect(await webhooks.markProcessed(envelope.idempotencyKey, current!.leaseToken)).toBe(true);
  });

  it('keeps newer session status and restriction observations when events arrive out of order', async () => {
    await seedSendableGroup(pool);
    const runtimeEvents = new RuntimeEventRepository(
      database,
      new GatewayGroupIntentRepository(database),
    );
    const newer = new Date('2026-08-12T00:00:00.000Z');
    const older = new Date('2026-08-11T00:00:00.000Z');

    await runtimeEvents.store({
      eventId: 'new-status', sourceEventType: 'session.status', eventType: 'session.status.changed', eventVersion: 1,
      sessionId: INTEGRATION_SESSION_ID, occurredAt: newer, payload: { status: 'ready' },
    });
    await runtimeEvents.store({
      eventId: 'old-status', sourceEventType: 'session.status', eventType: 'session.status.changed', eventVersion: 1,
      sessionId: INTEGRATION_SESSION_ID, occurredAt: older, payload: { status: 'disconnected' },
    });
    await runtimeEvents.store({
      eventId: 'new-restriction', sourceEventType: 'session.restriction',
      eventType: 'session.restriction.changed', eventVersion: 1,
      sessionId: INTEGRATION_SESSION_ID, occurredAt: newer,
      payload: { active: true, kind: 'RATE_LIMIT', code: 'newer' },
    });
    await runtimeEvents.store({
      eventId: 'old-restriction', sourceEventType: 'session.restriction',
      eventType: 'session.restriction.changed', eventVersion: 1,
      sessionId: INTEGRATION_SESSION_ID, occurredAt: older, payload: { active: false },
    });
    const gateway = new GatewayRepository(database, new ContactRepository(database));
    await gateway.upsertSession({
      id: INTEGRATION_SESSION_ID,
      name: 'Older snapshot',
      status: 'disconnected',
      engineLoaded: false,
      restriction: null,
      createdAt: older.toISOString(),
      updatedAt: older.toISOString(),
    });

    const state = await pool.query<{
      status: string; restriction: Record<string, unknown>;
      status_observed_at: Date; restriction_observed_at: Date;
    }>(
      `SELECT status, restriction, status_observed_at, restriction_observed_at
       FROM gateway_sessions WHERE id = $1`,
      [INTEGRATION_SESSION_ID],
    );
    expect(state.rows[0]).toMatchObject({
      status: 'ready',
      restriction: { active: true, kind: 'RATE_LIMIT', code: 'newer' },
      status_observed_at: newer,
      restriction_observed_at: newer,
    });
  });

  it('uses first-observation ownership for distinct session events with equal timestamps', async () => {
    await seedSendableGroup(pool);
    const runtimeEvents = new RuntimeEventRepository(
      database,
      new GatewayGroupIntentRepository(database),
    );
    const occurredAt = new Date('2026-08-12T00:00:00.000Z');

    await runtimeEvents.store({
      eventId: 'equal-status-first', sourceEventType: 'session.status',
      eventType: 'session.status.changed', eventVersion: 1,
      sessionId: INTEGRATION_SESSION_ID, occurredAt, payload: { status: 'ready' },
    });
    await runtimeEvents.store({
      eventId: 'equal-status-second', sourceEventType: 'session.status',
      eventType: 'session.status.changed', eventVersion: 1,
      sessionId: INTEGRATION_SESSION_ID, occurredAt, payload: { status: 'disconnected' },
    });

    const state = await pool.query<{ status: string; status_observed_at: Date }>(
      'SELECT status, status_observed_at FROM gateway_sessions WHERE id = $1', [INTEGRATION_SESSION_ID],
    );
    expect(state.rows[0]).toEqual({ status: 'ready', status_observed_at: occurredAt });
  });

  it('coalesces duplicate and burst group events into one targeted intent', async () => {
    await seedSendableGroup(pool);
    const intents = new GatewayGroupIntentRepository(database);
    const runtimeEvents = new RuntimeEventRepository(
      database,
      intents,
    );
    const processor = new WebhookProcessorService(
      database,
      webhooks,
      runtimeEvents,
      new MessageStatusProjectionService(database),
      new ContactMessageObserverService(
        new ContactRepository(database),
        new ContactMessageObservationIntentRepository(database),
        true,
      ),
    );
    const event = (index: number): OpenWAWebhookEnvelope => ({
      event: 'group.update', timestamp: '2026-08-11T00:00:00.000Z',
      sessionId: INTEGRATION_SESSION_ID, idempotencyKey: `group-event-${index}`,
      deliveryId: `group-delivery-${index}`, data: { groupId: INTEGRATION_GROUP_ID },
    });

    await webhooks.insert(event(1));
    await processor.process(event(1).idempotencyKey);
    expect(await webhooks.insert(event(1))).toBe(false);
    for (let index = 2; index <= 20; index += 1) {
      await webhooks.insert(event(index));
      await processor.process(event(index).idempotencyKey);
    }

    const stored = await pool.query<{
      requested_revision: string; coalesced_count: string; status: string; reasons: string[];
    }>(
      `SELECT requested_revision::text, coalesced_count::text, status, reasons
       FROM gateway_group_reconciliation_intents WHERE session_id = $1 AND group_id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    expect(stored.rows[0]).toMatchObject({
      requested_revision: '20', coalesced_count: '19', status: 'PENDING', reasons: ['group.update'],
    });
    const operations = await pool.query<{ request_revision: string; status: string }>(
      `SELECT request_revision::text, status
       FROM gateway_group_reconciliation_operations
       WHERE session_id = $1 AND group_id = $2
       ORDER BY request_revision`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    expect(operations.rows).toHaveLength(20);
    expect(operations.rows.every(operation => operation.status === 'PENDING')).toBe(true);
    expect((await pool.query<{ bounded: boolean }>(
      `SELECT min(updated_at) < max(updated_at) AS bounded
       FROM gateway_group_reconciliation_operations
       WHERE session_id = $1 AND group_id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    )).rows[0]?.bounded).toBe(true);
    const dispatchable = await intents.listDispatchable(10);
    expect(dispatchable).toHaveLength(1);
    expect(dispatchable[0]!.availableAt).toBeInstanceOf(Date);

    await pool.query(
      `UPDATE gateway_group_reconciliation_intents SET not_before = now(), next_attempt_at = now()
       WHERE session_id = $1 AND group_id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    const openwa = {
      getGroup: vi.fn().mockResolvedValue({
        id: INTEGRATION_GROUP_ID, name: 'Coalesced group', participants: [],
        isAdmin: true, isReadOnly: false, announce: false,
      }),
    } as unknown as OpenWAClient;
    const sync = new GatewaySyncService(
      new GatewayRepository(database, new ContactRepository(database)), new GatewaySyncItemRepository(database), openwa, intents, {} as never,
    );
    await expect(sync.reconcileTargetedGroup(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID))
      .resolves.toMatchObject({ members: 0 });
    expect(openwa.getGroup).toHaveBeenCalledTimes(1);
    expect(await intents.findCapabilityRefresh(
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      20,
    )).toMatchObject({ status: 'COMPLETED', requestRevision: 20 });
    expect(await new GatewayRepository(
      database,
      new ContactRepository(database),
    ).findGroup(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID)).toMatchObject({
      sendCapability: {
        status: 'ALLOWED',
        invalidatedAt: null,
      },
    });
  });

  it('keeps automatic reconciliation gated while manual refresh remains dispatchable', async () => {
    await seedSendableGroup(pool);
    const config = {
      ...runtimeConfig(),
      GATEWAY_TARGETED_RECONCILIATION_ENABLED: false,
    };
    const intents = new GatewayGroupIntentRepository(
      database,
      new GatewaySyncRateLimitRepository(database, config),
      config,
    );
    await database.transaction(client => intents.scheduleInTransaction(
      client,
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      'group.update',
      { immediate: true },
    ));
    expect(await intents.listDispatchable(10)).toEqual([]);

    const operation = await intents.requestCapabilityRefresh(
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
    );
    expect(operation).toMatchObject({
      requestRevision: 1,
      source: 'MANUAL',
      status: 'PENDING',
    });
    expect(await intents.listDispatchable(10)).toEqual([
      expect.objectContaining({
        groupId: INTEGRATION_GROUP_ID,
        priority: 1,
        requestedRevision: 1,
      }),
    ]);
  });

  it('runs a subsequent revision when an event arrives during targeted reconciliation', async () => {
    await seedSendableGroup(pool);
    const intents = new GatewayGroupIntentRepository(database);
    const runtimeEvents = new RuntimeEventRepository(
      database,
      intents,
    );
    await runtimeEvents.store({
      eventId: 'running-event-1', sourceEventType: 'group.update', eventType: 'group.update', eventVersion: 1,
      sessionId: INTEGRATION_SESSION_ID, occurredAt: new Date(), payload: { groupId: INTEGRATION_GROUP_ID },
    });
    await pool.query(
      `UPDATE gateway_group_reconciliation_intents SET not_before = now(), next_attempt_at = now()
       WHERE session_id = $1 AND group_id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    let release!: () => void;
    const upstreamStarted = new Promise<void>(resolve => { release = resolve; });
    let unblock!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const openwa = {
      getGroup: vi.fn(async () => {
        release();
        await blocked;
        return {
          id: INTEGRATION_GROUP_ID, name: 'Updated group', participants: [],
          isAdmin: true, isReadOnly: false, announce: false,
        };
      }),
    } as unknown as OpenWAClient;
    const sync = new GatewaySyncService(
      new GatewayRepository(database, new ContactRepository(database)), new GatewaySyncItemRepository(database), openwa, intents, {} as never,
    );
    const first = sync.reconcileTargetedGroup(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID);
    await upstreamStarted;
    await runtimeEvents.store({
      eventId: 'running-event-2', sourceEventType: 'group.join', eventType: 'group.join', eventVersion: 1,
      sessionId: INTEGRATION_SESSION_ID, occurredAt: new Date(), payload: { groupId: INTEGRATION_GROUP_ID },
    });
    unblock();
    await expect(first).resolves.toMatchObject({ pending: true });

    const state = await pool.query<{ requested_revision: string; completed_revision: string; status: string }>(
      `SELECT requested_revision::text, completed_revision::text, status
       FROM gateway_group_reconciliation_intents WHERE session_id = $1 AND group_id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    expect(state.rows[0]).toMatchObject({
      requested_revision: '2', completed_revision: '1', status: 'PENDING',
    });
  });

  it('recovers an expired attempt as pending when a newer revision arrived', async () => {
    await seedSendableGroup(pool);
    const intents = new GatewayGroupIntentRepository(database);
    const runtimeEvents = new RuntimeEventRepository(
      database,
      intents,
    );
    await runtimeEvents.store({
      eventId: 'expired-event-1', sourceEventType: 'group.update', eventType: 'group.update', eventVersion: 1,
      sessionId: INTEGRATION_SESSION_ID, occurredAt: new Date(), payload: { groupId: INTEGRATION_GROUP_ID },
    });
    await pool.query(
      `UPDATE gateway_group_reconciliation_intents SET not_before = now(), next_attempt_at = now()
       WHERE session_id = $1 AND group_id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    const claim = await intents.claim(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID);
    expect(claim).not.toBeNull();
    await runtimeEvents.store({
      eventId: 'expired-event-2', sourceEventType: 'group.join', eventType: 'group.join', eventVersion: 1,
      sessionId: INTEGRATION_SESSION_ID, occurredAt: new Date(), payload: { groupId: INTEGRATION_GROUP_ID },
    });
    await pool.query(
      `UPDATE gateway_group_reconciliation_intents SET attempt_count = 5,
         lease_expires_at = now() - interval '1 second'
       WHERE session_id = $1 AND group_id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );

    expect(await intents.recoverExpired()).toBe(1);
    const state = await pool.query(
      `SELECT status, attempt_count, requested_revision::text, completed_revision::text
       FROM gateway_group_reconciliation_intents WHERE session_id = $1 AND group_id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    expect(state.rows[0]).toMatchObject({
      status: 'PENDING', attempt_count: 0, requested_revision: '2', completed_revision: '0',
    });
  });
});
