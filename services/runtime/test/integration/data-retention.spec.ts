import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DatabaseService } from '../../src/core/database/database.service';
import { runtimeConfig } from '../../src/core/config/runtime-config';
import { DataRetentionTick } from '../../src/modules/orchestration/data-retention.tick';
import {
  INTEGRATION_GROUP_ID,
  INTEGRATION_SESSION_ID,
  integrationPool,
  resetIntegrationDatabase,
  seedSendableGroup,
} from '../support/integration-database';

describe('data retention', () => {
  let pool: Pool;
  let database: DatabaseService;

  beforeAll(() => {
    pool = integrationPool();
    database = new DatabaseService();
  });

  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
    await seedSendableGroup(pool);
  });

  afterAll(async () => {
    await database.onApplicationShutdown();
    await pool.end();
  });

  it('deletes old terminal graphs and preserves active work', async () => {
    const old = new Date(Date.now() - 100 * 86_400_000);
    await pool.query(
      `INSERT INTO message_jobs
         (idempotency_scope, idempotency_key, request_hash, session_id, recipient_id, payload,
          scheduled_at, status, dry_run, updated_at)
       VALUES
         ('runtime-api','old-terminal',$1,$2,$3,'{"type":"TEXT","text":"old"}',now(),'FAILED',false,$4),
         ('runtime-api','old-active',$1,$2,$3,'{"type":"TEXT","text":"active"}',now(),'PROCESSING',false,$4),
         ('runtime-api','old-unknown',$1,$2,$3,'{"type":"TEXT","text":"unknown"}',now(),'UNKNOWN',false,$4)`,
      ['a'.repeat(64), INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, old],
    );
    await pool.query(
      `INSERT INTO runtime_events
         (event_id, source_event_type, event_type, session_id, occurred_at, payload, created_at)
       VALUES ('old-event','message','message.received',$1,$2,'{}',$2),
              ('new-event','message','message.received',$1,now(),'{}',now())`,
      [INTEGRATION_SESSION_ID, old],
    );
    await pool.query(
      `INSERT INTO inbound_messages
         (session_id, message_id, group_id, sender_id, body, message_type, received_at, event_id)
       VALUES ($1,'old-message',$2,'sender','body','text',$3,'old-event')`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, old],
    );
    await pool.query(
      `INSERT INTO webhook_events
         (idempotency_key, event_type, payload, processing_state, processed_at, received_at,
          storage_bytes)
       VALUES ('old-webhook','message','{}','PROCESSED',$1,$1,0),
              ('active-webhook','message','{}','PROCESSING',NULL,$1,2),
              ('dead-webhook','message','{}','DEAD',$1,$1,3)`,
      [old],
    );
    await pool.query(
      `UPDATE runtime_webhook_spool_usage
       SET stored_events = 2, stored_bytes = 5, updated_at = now()`,
    );
    await pool.query(
      `INSERT INTO webhook_event_receipts
         (idempotency_key, event_type, received_at, processed_at, expires_at)
       VALUES ('expired-receipt','message',$1,$1,$1)`,
      [old],
    );
    await pool.query(
      `INSERT INTO gateway_sync_fences (session_id, current_epoch) VALUES ($1, 1)`,
      [INTEGRATION_SESSION_ID],
    );
    await pool.query(
      `INSERT INTO sync_runs
         (session_id, sync_type, status, phase, requested_at, completed_at,
          sync_epoch, lease_token, lease_expires_at)
       VALUES ($1,'full','COMPLETED','COMPLETED',$2,$2,NULL,NULL,NULL),
              ($1,'full','RUNNING','DISCOVERING',$2,NULL,1,gen_random_uuid(),now() + interval '2 minutes')`,
      [INTEGRATION_SESSION_ID, old],
    );
    const campaign = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (session_id, name, payload) VALUES ($1,'retention','{"type":"TEXT","text":"hello"}') RETURNING id`,
      [INTEGRATION_SESSION_ID],
    );
    const runs = await pool.query<{ id: string; status: string }>(
      `INSERT INTO campaign_runs
         (campaign_id, session_id, campaign_name_snapshot, idempotency_key, execution_mode,
          status, payload_snapshot, scheduled_at, updated_at)
       VALUES ($1,$2,'retention',$3,'DRY_RUN','COMPLETED','{"type":"TEXT","text":"hello"}',now(),$4),
              ($1,$2,'retention',$5,'DRY_RUN','RUNNING','{"type":"TEXT","text":"hello"}',now(),$4),
              ($1,$2,'retention',$6,'LIVE','PARTIAL_FAILED','{"type":"TEXT","text":"hello"}',now(),$4)
       RETURNING id, status`,
      [campaign.rows[0]!.id, INTEGRATION_SESSION_ID, randomUUID(), old, randomUUID(), randomUUID()],
    );
    const unresolvedRunId = runs.rows.find(row => row.status === 'PARTIAL_FAILED')!.id;
    await pool.query(
      `INSERT INTO campaign_run_targets
         (run_id, session_id, group_id, group_name, capability, capability_reason,
          capability_revision, capability_checked_at)
       SELECT $1, session_id, id, name, send_capability, send_capability_reason,
         capability_revision, capability_checked_at
       FROM gateway_groups WHERE session_id = $2 AND id = $3`,
      [unresolvedRunId, INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    const unresolvedJob = await pool.query<{ id: string }>(
      `INSERT INTO message_jobs
         (idempotency_scope, idempotency_key, request_hash, session_id, recipient_id, payload,
          scheduled_at, status, dry_run, updated_at)
       VALUES ($1,$2,$3,$4,$5,'{"type":"TEXT","text":"unknown"}',now(),'UNKNOWN',false,$6)
       RETURNING id`,
      [`campaign-run:${unresolvedRunId}`, INTEGRATION_GROUP_ID, 'b'.repeat(64),
        INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, old],
    );
    await pool.query(
      `INSERT INTO campaign_deliveries (run_id, group_id, message_job_id, status, updated_at)
       VALUES ($1, $2, $3, 'UNKNOWN', $4)`,
      [unresolvedRunId, INTEGRATION_GROUP_ID, unresolvedJob.rows[0]!.id, old],
    );
    await pool.query(
      `INSERT INTO activity_events
         (session_id, event_type, category, severity, origin, subject_type, subject_id,
          subject_label_snapshot, occurred_at, created_at)
       VALUES ($1,'session.discovered','SESSION','INFO','GATEWAY','SESSION',$1,'Old session',$2,$2),
              ($1,'session.health_changed','SESSION','SUCCESS','GATEWAY','SESSION',$1,'Current session',now(),now())`,
      [INTEGRATION_SESSION_ID, old],
    );
    await pool.query(
      `INSERT INTO openwa_safety_outcome_receipts
         (permit_token, upstream_id, session_id, operation_class, outcome_kind,
          policy_version, recorded_at)
       VALUES ($1, $2, $3, 'SESSION_READ', 'SUCCESS', 4, $4)`,
      [randomUUID(), 'a'.repeat(64), INTEGRATION_SESSION_ID, old],
    );

    const result = await new DataRetentionTick(database).cleanup();

    expect(result).toEqual({
      mutationReceipts: 0, safetyOutcomeReceipts: 1, groupReconciliationOperations: 0,
      activityEvents: 1, campaignRuns: 1, messageJobs: 1, inboundMessages: 0,
      runtimeEvents: 1, webhookEvents: 1, webhookReceipts: 1, syncRuns: 1,
      contactObservations: 0,
      mediaUploads: 0, mediaAssets: 0,
      batches: 1, capacityExhausted: false,
      storagePolicy: {
        version: 1,
        phase: 'NOT_APPLICABLE',
        inboundMessagesDeleted: 0,
        runtimeMessageEventsDeleted: 0,
        processedWebhooksCompacted: 0,
      },
    });
    await expectCount('message_jobs', 3);
    await expectCount('runtime_events', 1);
    await expectCount('inbound_messages', 0);
    await expectCount('webhook_events', 2);
    expect((await pool.query(
      `SELECT stored_events::text, stored_bytes::text FROM runtime_webhook_spool_usage`,
    )).rows).toEqual([{ stored_events: '2', stored_bytes: '5' }]);
    await expectCount('webhook_event_receipts', 0);
    await expectCount('sync_runs', 1);
    await expectCount('campaign_runs', 2);
    await expectCount('campaign_deliveries', 1);
    await expectCount('activity_events', 1);
  });

  it('expires mutation receipts before their old revision projections and preserves current history', async () => {
    const old = new Date(Date.now() - 100 * 86_400_000);
    await pool.query(
      `INSERT INTO gateway_group_reconciliation_intents
         (session_id, group_id, requested_revision, completed_revision, status,
          first_requested_at, last_requested_at, completed_at, updated_at)
       VALUES ($1, $2, 3, 3, 'COMPLETED', $3, $3, $3, $3)`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, old],
    );
    await pool.query(
      `INSERT INTO gateway_group_reconciliation_operations
         (session_id, group_id, request_revision, source, status, requested_at,
          next_attempt_at, completed_at, updated_at)
       VALUES ($1, $2, 1, 'MANUAL', 'COMPLETED', $3, $3, $3, $3),
              ($1, $2, 2, 'MANUAL', 'FAILED', $3, $3, $3, $3)`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, old],
    );
    await pool.query(
      `INSERT INTO runtime_mutation_receipts
         (operation_type, idempotency_key, request_hash, session_id, subject_id,
          result_id, result_revision, accepted_at)
       VALUES ('GROUP_CAPABILITY_REFRESH', $1, $3, $4, $5, $5, 1, $6),
              ('GROUP_CAPABILITY_REFRESH', $2, $3, $4, $5, $5, 2, now())`,
      [randomUUID(), randomUUID(), 'b'.repeat(64), INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, old],
    );

    const result = await new DataRetentionTick(database).cleanup();

    expect(result).toMatchObject({
      mutationReceipts: 1,
      groupReconciliationOperations: 1,
      capacityExhausted: false,
    });
    expect((await pool.query<{ request_revision: string }>(
      `SELECT request_revision::text FROM gateway_group_reconciliation_operations
       ORDER BY request_revision`,
    )).rows).toEqual([{ request_revision: '2' }, { request_revision: '3' }]);
    expect((await pool.query<{ result_revision: string }>(
      `SELECT result_revision::text FROM runtime_mutation_receipts`,
    )).rows).toEqual([{ result_revision: '2' }]);
  });

  it('drains more than one delete batch without one long transaction', async () => {
    const old = new Date(Date.now() - 100 * 86_400_000);
    await pool.query(
      `INSERT INTO runtime_events
         (event_id, source_event_type, event_type, session_id, occurred_at, payload, created_at)
       SELECT 'old-batch-' || value, 'message', 'message.received', $1, $2, '{}', $2
       FROM generate_series(1, 250) value`,
      [INTEGRATION_SESSION_ID, old],
    );

    const result = await new DataRetentionTick(database).cleanup({ batchSize: 100, maxBatches: 10 });

    expect(result).toMatchObject({ runtimeEvents: 250, batches: 3, capacityExhausted: false });
    await expectCount('runtime_events', 0);
  });

  it('removes expired uploads and orphan assets without deleting referenced Campaign media', async () => {
    const old = new Date(Date.now() - 48 * 3_600_000);
    const orphan = await pool.query<{ id: string }>(
      `INSERT INTO media_assets
         (session_id, kind, filename, mime_type, byte_size, sha256, content, created_at)
       VALUES ($1, 'IMAGE', 'orphan.png', 'image/png', 8, $2, $3, $4)
       RETURNING id`,
      [INTEGRATION_SESSION_ID, 'a'.repeat(64), Buffer.from('oldimage'), old],
    );
    const retained = await pool.query<{ id: string }>(
      `INSERT INTO media_assets
         (session_id, kind, filename, mime_type, byte_size, sha256, content, created_at)
       VALUES ($1, 'IMAGE', 'keep.png', 'image/png', 8, $2, $3, $4)
       RETURNING id`,
      [INTEGRATION_SESSION_ID, 'b'.repeat(64), Buffer.from('newimage'), old],
    );
    await pool.query(
      `INSERT INTO campaigns (session_id, name, message_type, media_asset_id, payload)
       VALUES ($1, 'media retention', 'image', $2::uuid,
         jsonb_build_object(
           'type', 'IMAGE', 'mediaAssetId', $2::uuid::text, 'caption', '',
           'filename', 'keep.png', 'mimeType', 'image/png',
           'byteSize', 8, 'sha256', $3::text
         ))`,
      [INTEGRATION_SESSION_ID, retained.rows[0]!.id, 'b'.repeat(64)],
    );
    const upload = await pool.query<{ id: string }>(
      `INSERT INTO media_uploads
         (session_id, kind, filename, declared_mime_type, byte_size, sha256, chunk_size,
          create_idempotency_key, create_request_hash, status, expires_at, created_at, updated_at)
       VALUES ($1, 'IMAGE', 'expired.png', 'image/png', 8, $2, 393216,
         gen_random_uuid(), $3, 'UPLOADING', $4, $4, $4)
       RETURNING id`,
      [INTEGRATION_SESSION_ID, 'c'.repeat(64), 'd'.repeat(64), old],
    );
    await pool.query(
      `INSERT INTO media_upload_chunks (upload_id, chunk_index, byte_size, sha256, content)
       VALUES ($1, 0, 8, $2, $3)`,
      [upload.rows[0]!.id, 'e'.repeat(64), Buffer.from('expimage')],
    );

    const result = await new DataRetentionTick(database).cleanup();

    expect(result).toMatchObject({ mediaUploads: 1, mediaAssets: 1 });
    expect((await pool.query('SELECT id FROM media_assets ORDER BY id')).rows).toEqual([
      { id: retained.rows[0]!.id },
    ]);
    await expectCount('media_uploads', 0);
    await expectCount('media_upload_chunks', 0);
    expect(orphan.rows[0]!.id).not.toBe(retained.rows[0]!.id);
  });

  it('uses shorter raw-webhook and normalized-event lifetimes than operational history', async () => {
    const tenDaysOld = new Date(Date.now() - 10 * 86_400_000);
    const fortyDaysOld = new Date(Date.now() - 40 * 86_400_000);
    await pool.query(
      `INSERT INTO runtime_events
         (event_id, source_event_type, event_type, session_id, occurred_at, payload, created_at)
       VALUES ('ten-day-event','message','message.received',$1,$2,'{}',$2),
              ('forty-day-event','message','message.received',$1,$3,'{}',$3)`,
      [INTEGRATION_SESSION_ID, tenDaysOld, fortyDaysOld],
    );
    await pool.query(
      `INSERT INTO webhook_events
         (idempotency_key, event_type, payload, processing_state, processed_at, received_at)
       VALUES ('ten-day-webhook','message','{}','PROCESSED',$1,$1)`,
      [tenDaysOld],
    );
    await pool.query(
      `INSERT INTO message_jobs
         (idempotency_scope, idempotency_key, request_hash, session_id, recipient_id, payload,
          scheduled_at, status, dry_run, updated_at)
       VALUES ('runtime-api','forty-day-job',$1,$2,$3,'{"type":"TEXT","text":"old"}',now(),'FAILED',false,$4)`,
      ['a'.repeat(64), INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, fortyDaysOld],
    );

    const result = await new DataRetentionTick(database).cleanup();

    expect(result).toMatchObject({ webhookEvents: 1, runtimeEvents: 1, messageJobs: 0 });
    expect((await pool.query('SELECT event_id FROM runtime_events')).rows).toEqual([
      { event_id: 'ten-day-event' },
    ]);
    await expectCount('message_jobs', 1);
  });

  it('expires inbox bodies independently while preserving their normalized event ledger', async () => {
    const tenDaysOld = new Date(Date.now() - 10 * 86_400_000);
    await pool.query(
      `INSERT INTO runtime_events
         (event_id, source_event_type, event_type, session_id, occurred_at, payload, created_at)
       VALUES ('inbox-retention-event','message','message.received',$1,$2,'{}',$2)`,
      [INTEGRATION_SESSION_ID, tenDaysOld],
    );
    await pool.query(
      `INSERT INTO inbound_messages
         (session_id, message_id, group_id, sender_id, body, message_type, received_at, event_id, created_at)
       VALUES ($1,'inbox-retention-message',$2,'sender','body','text',$3,'inbox-retention-event',$3)`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, tenDaysOld],
    );

    const result = await new DataRetentionTick(database, {
      ...runtimeConfig(),
      RUNTIME_INBOX_RETENTION_DAYS: 7,
      RUNTIME_EVENT_RETENTION_DAYS: 30,
    }).cleanup();

    expect(result).toMatchObject({ inboundMessages: 1, runtimeEvents: 0 });
    await expectCount('inbound_messages', 0);
    await expectCount('runtime_events', 1);
  });

  it('resumes draining legacy message bodies and processed webhooks under the desktop policy', async () => {
    await pool.query(
      `INSERT INTO runtime_events
         (event_id, source_event_type, event_type, session_id, occurred_at, payload, created_at)
       VALUES ('desktop-message-event','message','message.received',$1,now(),'{"body":"secret"}',now()),
              ('desktop-status-event','ack','message.ack',$1,now(),'{"status":"sent"}',now())`,
      [INTEGRATION_SESSION_ID],
    );
    await pool.query(
      `INSERT INTO inbound_messages
         (session_id, message_id, group_id, sender_id, body, message_type, received_at, event_id)
       VALUES ($1,'desktop-message',$2,'sender','secret','text',now(),'desktop-message-event')`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    await pool.query(
      `INSERT INTO webhook_events
         (idempotency_key, event_type, session_id, payload, processing_state, processed_at,
          received_at, storage_bytes)
       VALUES ('legacy-processed','message.received',$1,'{"data":{"body":"secret"}}',
         'PROCESSED',now(),now(),0)`,
      [INTEGRATION_SESSION_ID],
    );
    const config = {
      ...runtimeConfig(),
      RUNTIME_PROFILE: 'desktop-managed' as const,
      RUNTIME_MESSAGE_STORAGE_MODE: 'disabled' as const,
      RUNTIME_COMPACT_PROCESSED_WEBHOOK_PAYLOAD_ENABLED: true,
    };

    const first = await new DataRetentionTick(database, config).cleanup({
      batchSize: 100,
      maxBatches: 1,
    });

    expect(first).toMatchObject({
      inboundMessages: 1,
      runtimeEvents: 1,
      webhookEvents: 1,
      storagePolicy: {
        version: 1,
        phase: 'LOGICALLY_COMPACT',
        inboundMessagesDeleted: 1,
        runtimeMessageEventsDeleted: 1,
        processedWebhooksCompacted: 1,
      },
    });
    await expectCount('inbound_messages', 0);
    expect((await pool.query<{ event_id: string }>(
      'SELECT event_id FROM runtime_events ORDER BY event_id',
    )).rows).toEqual([{ event_id: 'desktop-status-event' }]);
    await expectCount('webhook_events', 0);
    await expectCount('webhook_event_receipts', 1);
    expect((await pool.query<{
      phase: string;
      inbound_messages_deleted: string;
      runtime_message_events_deleted: string;
      processed_webhooks_compacted: string;
      completed_at: Date | null;
    }>(
      `SELECT phase, inbound_messages_deleted::text, runtime_message_events_deleted::text,
         processed_webhooks_compacted::text, completed_at
       FROM runtime_storage_policy_state WHERE singleton = true`,
    )).rows[0]).toMatchObject({
      phase: 'LOGICALLY_COMPACT',
      inbound_messages_deleted: '1',
      runtime_message_events_deleted: '1',
      processed_webhooks_compacted: '1',
      completed_at: expect.any(Date),
    });

    const resumed = await new DataRetentionTick(database, config).cleanup({
      batchSize: 100,
      maxBatches: 1,
    });
    expect(resumed.storagePolicy).toMatchObject({
      phase: 'LOGICALLY_COMPACT',
      inboundMessagesDeleted: 0,
      runtimeMessageEventsDeleted: 0,
      processedWebhooksCompacted: 0,
    });
  });

  it('reports remaining capacity pressure when the configured batch cap is reached', async () => {
    const old = new Date(Date.now() - 100 * 86_400_000);
    await pool.query(
      `INSERT INTO runtime_events
         (event_id, source_event_type, event_type, session_id, occurred_at, payload, created_at)
       SELECT 'capped-batch-' || value, 'message', 'message.received', $1, $2, '{}', $2
       FROM generate_series(1, 250) value`,
      [INTEGRATION_SESSION_ID, old],
    );

    const result = await new DataRetentionTick(database).cleanup({ batchSize: 100, maxBatches: 2 });

    expect(result).toMatchObject({ runtimeEvents: 200, batches: 2, capacityExhausted: true });
    await expectCount('runtime_events', 50);
  });

  it('uses bounded autovacuum thresholds for high-churn retained tables', async () => {
    const result = await pool.query<{ relname: string; reloptions: string[] }>(
      `SELECT relation.relname, relation.reloptions
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname IN (
           'webhook_events', 'runtime_events', 'inbound_messages', 'contact_observations',
           'runtime_mutation_receipts', 'gateway_group_reconciliation_operations'
         )
       ORDER BY relation.relname`,
    );

    expect(result.rows).toHaveLength(6);
    for (const row of result.rows) {
      expect(new Set(row.reloptions)).toEqual(new Set([
        'autovacuum_vacuum_threshold=10000',
        'autovacuum_vacuum_scale_factor=0.05',
        'autovacuum_analyze_threshold=10000',
        'autovacuum_analyze_scale_factor=0.02',
      ]));
    }
  });

  it('indexes active-work, mutation-receipt, and protected-observation retention guards', async () => {
    const result = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname IN (
         'idx_contact_projection_work_active_session',
         'idx_resolved_contact_clusters_name_observation',
         'idx_runtime_mutation_receipts_retention'
       )
       ORDER BY indexname`,
    );

    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({
      indexname: 'idx_contact_projection_work_active_session',
    });
    expect(result.rows[0]!.indexdef).toContain('(session_id) WHERE (status = ANY');
    expect(result.rows[1]).toMatchObject({
      indexname: 'idx_resolved_contact_clusters_name_observation',
    });
    expect(result.rows[1]!.indexdef).toContain('(session_id, contact_name_observation_id)');
    expect(result.rows[1]!.indexdef).toContain('contact_name_observation_id IS NOT NULL');
    expect(result.rows[2]).toMatchObject({
      indexname: 'idx_runtime_mutation_receipts_retention',
    });
    expect(result.rows[2]!.indexdef).toContain('(accepted_at, operation_type, idempotency_key)');
  });

  it('compacts old push-name history only after derived contact work is idle', async () => {
    const old = new Date(Date.now() - 40 * 86_400_000);
    const identity = await pool.query<{ id: string }>(
      `INSERT INTO observed_contact_identities (session_id, identity_type, identity_value)
       VALUES ($1, 'LID', 'retention-probe@lid') RETURNING id`,
      [INTEGRATION_SESSION_ID],
    );
    await pool.query(
      `INSERT INTO contact_observations
         (session_id, identity_id, observation_source, observation_scope, name_value,
          source_observed_at, source_observation_key, created_at)
       VALUES ($1, $2, 'OPENWA_PUSH_NAME', 'IDENTITY', 'Older name', $3, 'old-name', $3),
              ($1, $2, 'OPENWA_PUSH_NAME', 'IDENTITY', 'Current name', now(), 'new-name', now())`,
      [INTEGRATION_SESSION_ID, identity.rows[0]!.id, old],
    );
    await pool.query(
      `INSERT INTO contact_projection_work (session_id, identity_id, status)
       VALUES ($1, $2, 'PENDING')`,
      [INTEGRATION_SESSION_ID, identity.rows[0]!.id],
    );

    const guarded = await new DataRetentionTick(database).cleanup();
    expect(guarded.contactObservations).toBe(0);
    await pool.query(
      `UPDATE contact_projection_work SET status = 'IDLE' WHERE session_id = $1 AND identity_id = $2`,
      [INTEGRATION_SESSION_ID, identity.rows[0]!.id],
    );

    const compacted = await new DataRetentionTick(database).cleanup();
    expect(compacted.contactObservations).toBe(1);
    const retained = await pool.query<{ name_value: string }>(
      `SELECT name_value FROM contact_observations
       WHERE session_id = $1 AND identity_id = $2`,
      [INTEGRATION_SESSION_ID, identity.rows[0]!.id],
    );
    expect(retained.rows).toEqual([{ name_value: 'Current name' }]);
  });

  async function expectCount(table: string, expected: number): Promise<void> {
    const result = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
    expect(Number(result.rows[0]!.count)).toBe(expected);
  }
});
