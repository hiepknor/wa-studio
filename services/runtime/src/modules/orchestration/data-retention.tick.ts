import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PoolClient, QueryResult } from 'pg';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { DatabaseService } from '../../core/database/database.service';
import {
  decrementRuntimeWebhookSpoolUsage,
  lockRuntimeWebhookSpoolUsage,
} from '../../core/database/runtime-webhook-spool';

export interface RetentionResult {
  mutationReceipts: number;
  safetyOutcomeReceipts: number;
  groupReconciliationOperations: number;
  activityEvents: number;
  campaignRuns: number;
  messageJobs: number;
  inboundMessages: number;
  runtimeEvents: number;
  webhookEvents: number;
  webhookReceipts: number;
  syncRuns: number;
  contactObservations: number;
  mediaUploads: number;
  mediaAssets: number;
  batches: number;
  capacityExhausted: boolean;
}

interface RetentionOptions {
  batchSize?: number;
  maxBatches?: number;
  timeBudgetMs?: number;
  now?: Date;
}

@Injectable()
export class DataRetentionTick {
  private readonly logger = new Logger(DataRetentionTick.name);
  constructor(
    private readonly database: DatabaseService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async run(): Promise<void> {
    const started = performance.now();
    const result = await this.cleanup();
    const deleted = result.mutationReceipts + result.safetyOutcomeReceipts
      + result.groupReconciliationOperations
      + result.activityEvents + result.campaignRuns + result.messageJobs + result.inboundMessages + result.runtimeEvents
      + result.webhookEvents + result.webhookReceipts + result.syncRuns
      + result.contactObservations + result.mediaUploads + result.mediaAssets;
    this.logger.log({
      event: 'data.retention.completed', deleted, durationMs: Math.round(performance.now() - started), ...result,
    });
  }

  async cleanup(options: RetentionOptions = {}): Promise<RetentionResult> {
    const now = options.now ?? new Date();
    const operationalCutoff = new Date(now.valueOf() - this.config.RUNTIME_RETENTION_DAYS * 86_400_000);
    const activityCutoff = new Date(now.valueOf() - this.config.RUNTIME_ACTIVITY_RETENTION_DAYS * 86_400_000);
    const eventCutoff = new Date(now.valueOf() - this.config.RUNTIME_EVENT_RETENTION_DAYS * 86_400_000);
    const inboxCutoff = new Date(now.valueOf() - this.config.RUNTIME_INBOX_RETENTION_DAYS * 86_400_000);
    const webhookCutoff = new Date(now.valueOf() - this.config.RUNTIME_RAW_WEBHOOK_RETENTION_DAYS * 86_400_000);
    const contactObservationCutoff = new Date(
      now.valueOf() - this.config.CONTACT_MESSAGE_OBSERVATION_RETENTION_DAYS * 86_400_000,
    );
    const mediaOrphanCutoff = new Date(
      now.valueOf() - this.config.CAMPAIGN_MEDIA_ORPHAN_RETENTION_HOURS * 3_600_000,
    );
    const limit = options.batchSize ?? this.config.RUNTIME_RETENTION_BATCH_SIZE;
    const maxBatches = options.maxBatches ?? this.config.RUNTIME_RETENTION_MAX_BATCHES_PER_RUN;
    const deadline = performance.now() + (options.timeBudgetMs ?? this.config.RUNTIME_RETENTION_TIME_BUDGET_MS);
    const total: RetentionResult = {
      mutationReceipts: 0,
      safetyOutcomeReceipts: 0,
      groupReconciliationOperations: 0,
      activityEvents: 0,
      campaignRuns: 0, messageJobs: 0, inboundMessages: 0, runtimeEvents: 0,
      webhookEvents: 0, webhookReceipts: 0, syncRuns: 0,
      contactObservations: 0,
      mediaUploads: 0, mediaAssets: 0,
      batches: 0, capacityExhausted: false,
    };
    let drained = false;

    for (let batch = 0; batch < maxBatches; batch += 1) {
      if (performance.now() >= deadline) {
        total.capacityExhausted = true;
        break;
      }
      const current = await this.database.transaction(async client => ({
        mutationReceipts: await this.deleteMutationReceipts(client, operationalCutoff, limit),
        safetyOutcomeReceipts: await this.deleteSafetyOutcomeReceipts(
          client,
          operationalCutoff,
          limit,
        ),
        groupReconciliationOperations: await this.deleteGroupReconciliationOperations(
          client,
          operationalCutoff,
          limit,
        ),
        activityEvents: await this.deleteActivityEvents(client, activityCutoff, limit),
        campaignRuns: await this.deleteCampaignRuns(client, operationalCutoff, limit),
        messageJobs: await this.deleteMessageJobs(client, operationalCutoff, limit),
        inboundMessages: await this.deleteInboundMessages(client, inboxCutoff, limit),
        runtimeEvents: await this.deleteRuntimeEvents(client, eventCutoff, limit),
        webhookEvents: await this.deleteWebhookEvents(client, webhookCutoff, limit),
        webhookReceipts: await this.deleteWebhookReceipts(client, now, limit),
        syncRuns: await this.deleteSyncRuns(client, operationalCutoff, limit),
        contactObservations: await this.deleteRedundantContactObservations(
          client,
          contactObservationCutoff,
          limit,
        ),
        mediaUploads: await this.deleteExpiredMediaUploads(client, now, mediaOrphanCutoff, limit),
        mediaAssets: await this.deleteOrphanMediaAssets(client, mediaOrphanCutoff, limit),
      }));
      total.batches += 1;
      total.mutationReceipts += current.mutationReceipts;
      total.safetyOutcomeReceipts += current.safetyOutcomeReceipts;
      total.groupReconciliationOperations += current.groupReconciliationOperations;
      total.activityEvents += current.activityEvents;
      total.campaignRuns += current.campaignRuns;
      total.messageJobs += current.messageJobs;
      total.inboundMessages += current.inboundMessages;
      total.runtimeEvents += current.runtimeEvents;
      total.webhookEvents += current.webhookEvents;
      total.webhookReceipts += current.webhookReceipts;
      total.syncRuns += current.syncRuns;
      total.contactObservations += current.contactObservations;
      total.mediaUploads += current.mediaUploads;
      total.mediaAssets += current.mediaAssets;
      if (Object.values(current).every(count => count < limit)) {
        drained = true;
        break;
      }
    }
    if (!drained && total.batches === maxBatches) total.capacityExhausted = true;
    return total;
  }

  private async deleteMutationReceipts(client: PoolClient, cutoff: Date, limit: number): Promise<number> {
    return this.count(await client.query(
      `WITH candidates AS (
         SELECT operation_type, idempotency_key
         FROM runtime_mutation_receipts
         WHERE accepted_at < $1
         ORDER BY accepted_at, operation_type, idempotency_key
         LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       DELETE FROM runtime_mutation_receipts receipt USING candidates
       WHERE receipt.operation_type = candidates.operation_type
         AND receipt.idempotency_key = candidates.idempotency_key`,
      [cutoff, limit],
    ));
  }

  private async deleteSafetyOutcomeReceipts(
    client: PoolClient,
    cutoff: Date,
    limit: number,
  ): Promise<number> {
    return this.count(await client.query(
      `WITH candidates AS (
         SELECT permit_token FROM openwa_safety_outcome_receipts
         WHERE recorded_at < $1 ORDER BY recorded_at, permit_token
         LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       DELETE FROM openwa_safety_outcome_receipts receipt USING candidates
       WHERE receipt.permit_token = candidates.permit_token`,
      [cutoff, limit],
    ));
  }

  private async deleteGroupReconciliationOperations(
    client: PoolClient,
    cutoff: Date,
    limit: number,
  ): Promise<number> {
    return this.count(await client.query(
      `WITH candidates AS (
         SELECT operations.session_id, operations.group_id, operations.request_revision
         FROM gateway_group_reconciliation_operations operations
         JOIN gateway_group_reconciliation_intents intents
           ON intents.session_id = operations.session_id AND intents.group_id = operations.group_id
         WHERE operations.status IN ('COMPLETED', 'FAILED')
           AND operations.completed_at < $1
           AND operations.request_revision < intents.requested_revision
           AND NOT EXISTS (
             SELECT 1 FROM runtime_mutation_receipts receipt
             WHERE receipt.operation_type = 'GROUP_CAPABILITY_REFRESH'
               AND receipt.session_id = operations.session_id
               AND receipt.subject_id = operations.group_id
               AND receipt.result_revision = operations.request_revision
           )
         ORDER BY operations.completed_at, operations.session_id,
           operations.group_id, operations.request_revision
         LIMIT $2 FOR UPDATE OF operations SKIP LOCKED
       )
       DELETE FROM gateway_group_reconciliation_operations operations USING candidates
       WHERE operations.session_id = candidates.session_id
         AND operations.group_id = candidates.group_id
         AND operations.request_revision = candidates.request_revision`,
      [cutoff, limit],
    ));
  }

  private async deleteActivityEvents(client: PoolClient, cutoff: Date, limit: number): Promise<number> {
    return this.count(await client.query(
      `WITH candidates AS (
         SELECT id FROM activity_events
         WHERE created_at < $1 ORDER BY created_at, id LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       DELETE FROM activity_events event USING candidates
       WHERE event.id = candidates.id`,
      [cutoff, limit],
    ));
  }

  private async deleteCampaignRuns(client: PoolClient, cutoff: Date, limit: number): Promise<number> {
    return this.count(await client.query(
      `WITH candidates AS (
         SELECT id FROM campaign_runs
         WHERE status IN ('COMPLETED','PARTIAL_FAILED','CANCELLED','FAILED') AND updated_at < $1
         ORDER BY updated_at, id LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       DELETE FROM campaign_runs cr USING candidates c WHERE cr.id = c.id`,
      [cutoff, limit],
    ));
  }

  private async deleteMessageJobs(client: PoolClient, cutoff: Date, limit: number): Promise<number> {
    return this.count(await client.query(
      `WITH candidates AS (
         SELECT mj.id FROM message_jobs mj
         WHERE mj.status IN ('ACCEPTED','SENT','DELIVERED','READ','FAILED','UNKNOWN','DRY_RUN_COMPLETED','CANCELLED')
           AND mj.updated_at < $1
           AND NOT EXISTS (SELECT 1 FROM campaign_deliveries cd WHERE cd.message_job_id = mj.id)
         ORDER BY mj.updated_at, mj.id LIMIT $2 FOR UPDATE OF mj SKIP LOCKED
       )
       DELETE FROM message_jobs mj USING candidates c WHERE mj.id = c.id`,
      [cutoff, limit],
    ));
  }

  private async deleteRuntimeEvents(client: PoolClient, cutoff: Date, limit: number): Promise<number> {
    return this.count(await client.query(
      `WITH candidates AS (
         SELECT event_id FROM runtime_events
         WHERE created_at < $1 ORDER BY created_at, event_id LIMIT $2 FOR UPDATE SKIP LOCKED
       ), deleted_message_events AS (
         DELETE FROM message_events me USING candidates c WHERE me.event_id = c.event_id
       ), deleted_inbound_messages AS (
         DELETE FROM inbound_messages im USING candidates c WHERE im.event_id = c.event_id
       )
       DELETE FROM runtime_events re USING candidates c WHERE re.event_id = c.event_id`,
      [cutoff, limit],
    ));
  }

  private async deleteInboundMessages(client: PoolClient, cutoff: Date, limit: number): Promise<number> {
    return this.count(await client.query(
      `WITH candidates AS (
         SELECT event_id FROM inbound_messages
         WHERE created_at < $1 ORDER BY created_at, event_id LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       DELETE FROM inbound_messages message USING candidates
       WHERE message.event_id = candidates.event_id`,
      [cutoff, limit],
    ));
  }

  private async deleteWebhookEvents(client: PoolClient, cutoff: Date, limit: number): Promise<number> {
    await lockRuntimeWebhookSpoolUsage(client);
    const result = await client.query<{ processing_state: string; storage_bytes: string }>(
      `WITH candidates AS (
         SELECT id FROM webhook_events
         WHERE processing_state IN ('PROCESSED','DEAD') AND COALESCE(processed_at, received_at) < $1
         ORDER BY COALESCE(processed_at, received_at), id LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       DELETE FROM webhook_events we USING candidates c WHERE we.id = c.id
       RETURNING we.processing_state, we.storage_bytes::text`,
      [cutoff, limit],
    );
    const counted = result.rows.filter(row => row.processing_state !== 'PROCESSED');
    await decrementRuntimeWebhookSpoolUsage(
      client,
      counted.length,
      counted.reduce((total, row) => total + Number(row.storage_bytes), 0),
    );
    return result.rowCount ?? 0;
  }

  private async deleteWebhookReceipts(client: PoolClient, now: Date, limit: number): Promise<number> {
    return this.count(await client.query(
      `WITH candidates AS (
         SELECT idempotency_key FROM webhook_event_receipts
         WHERE expires_at < $1 ORDER BY expires_at, idempotency_key
         LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       DELETE FROM webhook_event_receipts receipt USING candidates
       WHERE receipt.idempotency_key = candidates.idempotency_key`,
      [now, limit],
    ));
  }

  private async deleteSyncRuns(client: PoolClient, cutoff: Date, limit: number): Promise<number> {
    return this.count(await client.query(
      `WITH candidates AS (
         SELECT id FROM sync_runs
         WHERE status IN ('COMPLETED','FAILED') AND completed_at < $1
         ORDER BY completed_at, id LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       DELETE FROM sync_runs sr USING candidates c WHERE sr.id = c.id`,
      [cutoff, limit],
    ));
  }

  private async deleteRedundantContactObservations(
    client: PoolClient,
    cutoff: Date,
    limit: number,
  ): Promise<number> {
    return this.count(await client.query(
      `WITH candidates AS (
         SELECT observation.session_id, observation.id
         FROM contact_observations observation
         WHERE observation.source_generation IS NULL
           AND observation.observation_source = 'OPENWA_PUSH_NAME'
           AND observation.created_at < $1
           AND EXISTS (
             SELECT 1 FROM contact_observations newer
             WHERE newer.session_id = observation.session_id
               AND newer.identity_id = observation.identity_id
               AND newer.observation_source = observation.observation_source
               AND newer.source_generation IS NULL
               AND (newer.source_observed_at, newer.source_observation_key, newer.id)
                 > (observation.source_observed_at, observation.source_observation_key, observation.id)
           )
           AND NOT EXISTS (
             SELECT 1 FROM contact_resolution_runs resolution
             WHERE resolution.session_id = observation.session_id
               AND resolution.status IN ('PENDING', 'RUNNING', 'RETRY')
           )
           AND NOT EXISTS (
             SELECT 1 FROM contact_projection_work work
             WHERE work.session_id = observation.session_id
               AND work.status IN ('PENDING', 'RUNNING', 'RETRY')
           )
           AND NOT EXISTS (
             SELECT 1 FROM resolved_contact_clusters cluster
             WHERE cluster.session_id = observation.session_id
               AND cluster.contact_name_observation_id = observation.id
           )
         ORDER BY observation.created_at, observation.id
         LIMIT $2 FOR UPDATE OF observation SKIP LOCKED
       )
       DELETE FROM contact_observations observation USING candidates
       WHERE observation.session_id = candidates.session_id AND observation.id = candidates.id`,
      [cutoff, limit],
    ));
  }

  private async deleteExpiredMediaUploads(
    client: PoolClient,
    now: Date,
    settledCutoff: Date,
    limit: number,
  ): Promise<number> {
    return this.count(await client.query(
      `WITH candidates AS (
         SELECT id FROM media_uploads
         WHERE (status = 'UPLOADING' AND expires_at < $1)
           OR (status IN ('COMPLETED','CANCELLED') AND updated_at < $2)
         ORDER BY updated_at, id LIMIT $3 FOR UPDATE SKIP LOCKED
       )
       DELETE FROM media_uploads upload USING candidates
       WHERE upload.id = candidates.id`,
      [now, settledCutoff, limit],
    ));
  }

  private async deleteOrphanMediaAssets(
    client: PoolClient,
    cutoff: Date,
    limit: number,
  ): Promise<number> {
    return this.count(await client.query(
      `WITH candidates AS (
         SELECT asset.id FROM media_assets asset
         WHERE asset.created_at < $1
           AND NOT EXISTS (SELECT 1 FROM campaigns c WHERE c.media_asset_id = asset.id)
           AND NOT EXISTS (SELECT 1 FROM campaign_runs cr WHERE cr.media_asset_id = asset.id)
           AND NOT EXISTS (SELECT 1 FROM message_jobs mj WHERE mj.media_asset_id = asset.id)
           AND NOT EXISTS (SELECT 1 FROM media_uploads mu WHERE mu.completed_asset_id = asset.id)
         ORDER BY asset.created_at, asset.id LIMIT $2 FOR UPDATE OF asset SKIP LOCKED
       )
       DELETE FROM media_assets asset USING candidates
       WHERE asset.id = candidates.id`,
      [cutoff, limit],
    ));
  }

  private count(result: QueryResult): number {
    return result.rowCount ?? 0;
  }
}
