import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import type { MessageJob, MessageJobStatus } from './message-job.types';
import {
  CampaignContentType,
  campaignContentMediaAssetId,
  campaignContentMessageType,
  type CampaignContentDto,
} from '../../contracts/campaigns/campaign-content.dto';

const defaultProcessingLeaseTtlMs = 120_000;

interface MessageJobRow {
  id: string;
  idempotency_key: string;
  session_id: string;
  recipient_id: string;
  message_type: string;
  media_asset_id: string | null;
  payload: CampaignContentDto;
  scheduled_at: Date;
  status: MessageJobStatus;
  dry_run: boolean;
  claim_count: number;
  attempt_count: number;
  current_upstream_started_at: Date | null;
  safety_policy_version: number | null;
  cancellation_requested_at: Date | null;
  openwa_message_id: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

const map = (row: MessageJobRow): MessageJob => ({
  id: row.id,
  idempotencyKey: row.idempotency_key,
  sessionId: row.session_id,
  recipientId: row.recipient_id,
  payload: row.payload,
  scheduledAt: row.scheduled_at,
  status: row.status,
  dryRun: row.dry_run,
  claimCount: row.claim_count,
  attemptCount: row.attempt_count,
  currentUpstreamStartedAt: row.current_upstream_started_at,
  safetyPolicyVersion: row.safety_policy_version,
  cancellationRequestedAt: row.cancellation_requested_at,
  openwaMessageId: row.openwa_message_id,
  lastError: row.last_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

@Injectable()
export class MessageJobRepository {
  constructor(private readonly database: DatabaseService) {}

  async create(input: {
    idempotencyScope: string;
    idempotencyKey: string;
    requestHash: string;
    sessionId: string;
    recipientId: string;
    text?: string;
    content?: CampaignContentDto;
    scheduledAt: Date;
    dryRun: boolean;
  }): Promise<{ job: MessageJob; created: boolean; idempotencyConflict: boolean }> {
    const content = input.content ?? { type: CampaignContentType.TEXT, text: input.text ?? '' };
    const inserted = await this.database.query<MessageJobRow>(
      `INSERT INTO message_jobs
         (idempotency_scope, idempotency_key, request_hash, session_id, recipient_id,
          message_type, media_asset_id, payload, scheduled_at, dry_run)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       ON CONFLICT (idempotency_scope, idempotency_key) DO NOTHING
       RETURNING *`,
      [input.idempotencyScope, input.idempotencyKey, input.requestHash, input.sessionId, input.recipientId,
        campaignContentMessageType(content), campaignContentMediaAssetId(content), JSON.stringify(content),
        input.scheduledAt, input.dryRun],
    );
    if (inserted.rows[0]) return { job: map(inserted.rows[0]), created: true, idempotencyConflict: false };

    const existing = await this.database.query<MessageJobRow & { request_hash: string }>(
      'SELECT * FROM message_jobs WHERE idempotency_scope = $1 AND idempotency_key = $2',
      [input.idempotencyScope, input.idempotencyKey],
    );
    const row = existing.rows[0]!;
    return { job: map(row), created: false, idempotencyConflict: row.request_hash !== input.requestHash };
  }

  async createWithClient(client: PoolClient, input: {
    idempotencyScope: string;
    idempotencyKey: string;
    requestHash: string;
    sessionId: string;
    recipientId: string;
    text?: string;
    content?: CampaignContentDto;
    scheduledAt: Date;
    dryRun: boolean;
  }): Promise<{ job: MessageJob; created: boolean; idempotencyConflict: boolean }> {
    const content = input.content ?? { type: CampaignContentType.TEXT, text: input.text ?? '' };
    const inserted = await client.query<MessageJobRow>(
      `INSERT INTO message_jobs
         (idempotency_scope, idempotency_key, request_hash, session_id, recipient_id,
          message_type, media_asset_id, payload, scheduled_at, dry_run)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       ON CONFLICT (idempotency_scope, idempotency_key) DO NOTHING
       RETURNING *`,
      [input.idempotencyScope, input.idempotencyKey, input.requestHash, input.sessionId, input.recipientId,
        campaignContentMessageType(content), campaignContentMediaAssetId(content), JSON.stringify(content),
        input.scheduledAt, input.dryRun],
    );
    if (inserted.rows[0]) return { job: map(inserted.rows[0]), created: true, idempotencyConflict: false };
    const existing = await client.query<MessageJobRow & { request_hash: string }>(
      'SELECT * FROM message_jobs WHERE idempotency_scope = $1 AND idempotency_key = $2',
      [input.idempotencyScope, input.idempotencyKey],
    );
    const row = existing.rows[0]!;
    return { job: map(row), created: false, idempotencyConflict: row.request_hash !== input.requestHash };
  }

  async find(id: string): Promise<MessageJob | null> {
    const result = await this.database.query<MessageJobRow>('SELECT * FROM message_jobs WHERE id = $1', [id]);
    return result.rows[0] ? map(result.rows[0]) : null;
  }

  async claimDue(limit: number): Promise<MessageJob[]> {
    if (limit <= 0) return [];
    return this.database.transaction(async client => {
      await client.query(
        `INSERT INTO message_dispatch_session_lanes (session_id)
         SELECT DISTINCT jobs.session_id FROM message_jobs jobs
         WHERE jobs.status = 'SCHEDULED' AND jobs.dry_run = false
           AND (jobs.scheduled_at <= now()
             OR jobs.defer_reason = 'SESSION_OPERATION_IN_FLIGHT')
         ON CONFLICT (session_id) DO NOTHING`,
      );

      const live = await client.query<MessageJobRow>(
        `WITH locked_lanes AS MATERIALIZED (
           SELECT lanes.session_id
           FROM message_dispatch_session_lanes lanes
           CROSS JOIN LATERAL (
             SELECT jobs.scheduled_at, jobs.created_at, jobs.id, jobs.defer_reason
             FROM message_jobs jobs
             WHERE jobs.session_id = lanes.session_id
               AND jobs.status = 'SCHEDULED' AND jobs.dry_run = false
               AND (jobs.scheduled_at <= now()
                 OR jobs.defer_reason = 'SESSION_OPERATION_IN_FLIGHT')
               AND NOT EXISTS (
                 SELECT 1 FROM campaign_deliveries deliveries
                 JOIN campaign_runs runs ON runs.id = deliveries.run_id
                 WHERE deliveries.message_job_id = jobs.id AND runs.status <> 'RUNNING'
               )
             ORDER BY (jobs.defer_reason = 'SESSION_OPERATION_IN_FLIGHT') DESC,
               jobs.scheduled_at, jobs.created_at, jobs.id
             LIMIT 1
           ) due
           WHERE NOT EXISTS (
             SELECT 1 FROM message_jobs active
             WHERE active.session_id = lanes.session_id AND active.dry_run = false
               AND active.status IN ('QUEUED', 'PROCESSING')
           )
             AND NOT EXISTS (
               SELECT 1 FROM openwa_safety_leases safety
               WHERE safety.scope_type = 'SESSION' AND safety.session_id = lanes.session_id
                 AND safety.lane = 'ACTIVE_SESSION' AND safety.lease_expires_at > now()
             )
           ORDER BY (due.defer_reason = 'SESSION_OPERATION_IN_FLIGHT') DESC,
             due.scheduled_at, due.created_at, due.id
           FOR UPDATE OF lanes SKIP LOCKED
           LIMIT $1
         ), candidates AS MATERIALIZED (
           SELECT candidate.id
           FROM locked_lanes lanes
           CROSS JOIN LATERAL (
             SELECT jobs.id
             FROM message_jobs jobs
             WHERE jobs.session_id = lanes.session_id
               AND jobs.status = 'SCHEDULED' AND jobs.dry_run = false
               AND (jobs.scheduled_at <= now()
                 OR jobs.defer_reason = 'SESSION_OPERATION_IN_FLIGHT')
               AND NOT EXISTS (
                 SELECT 1 FROM campaign_deliveries deliveries
                 JOIN campaign_runs runs ON runs.id = deliveries.run_id
                 WHERE deliveries.message_job_id = jobs.id AND runs.status <> 'RUNNING'
               )
             ORDER BY (jobs.defer_reason = 'SESSION_OPERATION_IN_FLIGHT') DESC,
               jobs.scheduled_at, jobs.created_at, jobs.id
             FOR UPDATE OF jobs SKIP LOCKED
             LIMIT 1
           ) candidate
         )
         UPDATE message_jobs jobs
         SET status = 'QUEUED', defer_reason = NULL, updated_at = now()
         FROM candidates
         WHERE jobs.id = candidates.id AND jobs.status = 'SCHEDULED'
         RETURNING jobs.*`,
        [limit],
      );

      const remaining = limit - live.rows.length;
      if (remaining <= 0) return live.rows.map(map);
      const dry = await client.query<MessageJobRow>(
        `WITH candidates AS MATERIALIZED (
           SELECT jobs.id FROM message_jobs jobs
           WHERE jobs.status = 'SCHEDULED' AND jobs.dry_run = true
             AND jobs.scheduled_at <= now()
             AND NOT EXISTS (
               SELECT 1 FROM campaign_deliveries deliveries
               JOIN campaign_runs runs ON runs.id = deliveries.run_id
               WHERE deliveries.message_job_id = jobs.id AND runs.status <> 'RUNNING'
             )
           ORDER BY jobs.scheduled_at, jobs.created_at, jobs.id
           FOR UPDATE OF jobs SKIP LOCKED
           LIMIT $1
         )
         UPDATE message_jobs jobs
         SET status = 'QUEUED', defer_reason = NULL, updated_at = now()
         FROM candidates
         WHERE jobs.id = candidates.id AND jobs.status = 'SCHEDULED'
         RETURNING jobs.*`,
        [remaining],
      );
      return [...live.rows, ...dry.rows].map(map);
    });
  }

  async markProcessing(id: string): Promise<MessageJob | null> {
    const result = await this.database.query<MessageJobRow>(
      `UPDATE message_jobs
       SET status = 'PROCESSING', claim_count = claim_count + 1,
         processing_started_at = now(), lease_expires_at = now() + interval '2 minutes', updated_at = now()
       WHERE id = $1 AND status = 'QUEUED' AND cancellation_requested_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM campaign_deliveries deliveries
           JOIN campaign_runs runs ON runs.id = deliveries.run_id
           WHERE deliveries.message_job_id = message_jobs.id AND runs.status <> 'RUNNING'
         )
       RETURNING *`,
      [id],
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }

  async refreshProcessingLease(
    id: string,
    ttlMs = defaultProcessingLeaseTtlMs,
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE message_jobs
       SET lease_expires_at = now() + $2 * interval '1 millisecond', updated_at = now()
       WHERE id = $1 AND status = 'PROCESSING' AND lease_expires_at > now()`,
      [id, ttlMs],
    );
    return result.rowCount === 1;
  }

  async resetQueued(id: string, error: string): Promise<void> {
    await this.database.query(
      `UPDATE message_jobs
       SET status = 'SCHEDULED', last_error = $2, updated_at = now()
       WHERE id = $1 AND status = 'QUEUED'`,
      [id, error],
    );
  }

  async rescheduleProcessing(
    client: PoolClient,
    id: string,
    error: string,
    delayMs: number,
  ): Promise<boolean> {
    const owned = await client.query<{
      attempt_count: number;
      current_upstream_started_at: Date | null;
      safety_policy_version: number | null;
    }>(
      `SELECT attempt_count, current_upstream_started_at, safety_policy_version
       FROM message_jobs WHERE id = $1 AND status = 'PROCESSING' FOR UPDATE`,
      [id],
    );
    const before = owned.rows[0];
    if (!before) return false;
    const updated = await client.query(
      `UPDATE message_jobs SET status = 'SCHEDULED', scheduled_at = now() + $3 * interval '1 millisecond',
         last_error = $2, lease_expires_at = NULL, current_upstream_started_at = NULL,
         safety_lease_token = NULL, updated_at = now()
       WHERE id = $1 AND status = 'PROCESSING'
       RETURNING id`,
      [id, error, delayMs],
    );
    if (updated.rowCount !== 1) return false;
    await client.query(
        `INSERT INTO message_attempts
           (message_job_id, attempt_number, outcome, error, upstream_started_at, safety_policy_version)
         VALUES ($1, $2, 'RETRY', $3, $4, $5)
         ON CONFLICT (message_job_id, attempt_number) DO UPDATE SET
           outcome = 'RETRY', error = EXCLUDED.error,
           upstream_started_at = EXCLUDED.upstream_started_at,
           safety_policy_version = EXCLUDED.safety_policy_version,
           transport_state = 'FAILED_DEFINITIVE'::openwa_message_transport_state`,
      [id, before.attempt_count, error, before.current_upstream_started_at, before.safety_policy_version],
    );
    return true;
  }

  async deferProcessing(
    id: string,
    error: string,
    notBefore: Date,
    reason?: string,
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE message_jobs SET status = 'SCHEDULED', scheduled_at = $3, last_error = $2,
         defer_reason = $4, lease_expires_at = NULL, safety_lease_token = NULL, updated_at = now()
       WHERE id = $1 AND status = 'PROCESSING' AND current_upstream_started_at IS NULL`,
      [id, error, notBefore, reason ?? null],
    );
    return result.rowCount === 1;
  }

  async recoverStaleQueued(): Promise<number> {
    const result = await this.database.query(
      `UPDATE message_jobs
       SET status = 'SCHEDULED', last_error = 'Recovered stale queued job', updated_at = now()
       WHERE status = 'QUEUED' AND updated_at < now() - interval '2 minutes'`,
    );
    return result.rowCount ?? 0;
  }

  async markExpiredProcessingUnknown(): Promise<number> {
    await this.database.query(
      `UPDATE message_jobs SET status = 'SCHEDULED', scheduled_at = now(),
         last_error = 'Recovered processing job before upstream start',
         lease_expires_at = NULL, safety_lease_token = NULL, updated_at = now()
       WHERE status = 'PROCESSING' AND lease_expires_at < now()
         AND current_upstream_started_at IS NULL`,
    );
    const result = await this.database.query<{ count: string }>(
      `WITH expired AS (
         UPDATE message_jobs SET status = 'UNKNOWN',
           last_error = 'Processing lease expired; delivery outcome is unknown',
           lease_expires_at = NULL, safety_lease_token = NULL, updated_at = now()
         WHERE status = 'PROCESSING' AND lease_expires_at < now()
           AND current_upstream_started_at IS NOT NULL
         RETURNING id, attempt_count, current_upstream_started_at, safety_policy_version
       ), attempts AS (
         INSERT INTO message_attempts
           (message_job_id, attempt_number, outcome, error, upstream_started_at, safety_policy_version)
         SELECT id, attempt_count, 'UNKNOWN', 'Processing lease expired; delivery outcome is unknown',
           current_upstream_started_at, safety_policy_version
         FROM expired ON CONFLICT (message_job_id, attempt_number) DO UPDATE SET
           outcome = 'UNKNOWN', error = EXCLUDED.error,
           upstream_started_at = EXCLUDED.upstream_started_at,
           safety_policy_version = EXCLUDED.safety_policy_version,
           transport_state = 'INDETERMINATE'::openwa_message_transport_state
         RETURNING 1
       )
       SELECT count(*)::text AS count FROM expired`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async updateResult(
    client: PoolClient,
    id: string,
    status: MessageJobStatus,
    options: { openwaMessageId?: string; error?: string; response?: unknown } = {},
  ): Promise<void> {
    const updated = await client.query<MessageJobRow>(
      `UPDATE message_jobs
       SET status = $2, openwa_message_id = COALESCE($3, openwa_message_id), last_error = $4,
         lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'PROCESSING'
       RETURNING attempt_count, current_upstream_started_at, safety_policy_version`,
      [id, status, options.openwaMessageId ?? null, options.error ?? null],
    );
    const attempt = updated.rows[0]?.attempt_count;
    if (attempt !== undefined) {
      await client.query(
         `INSERT INTO message_attempts
           (message_job_id, attempt_number, outcome, response, error, upstream_started_at,
            safety_policy_version)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
         ON CONFLICT (message_job_id, attempt_number) DO UPDATE SET
           outcome = EXCLUDED.outcome,
           response = EXCLUDED.response,
           error = EXCLUDED.error,
           upstream_started_at = EXCLUDED.upstream_started_at,
           safety_policy_version = EXCLUDED.safety_policy_version,
           transport_state = CASE EXCLUDED.outcome
             WHEN 'ACCEPTED' THEN 'SEND_ACCEPTED'::openwa_message_transport_state
             WHEN 'SENT' THEN 'SENT'::openwa_message_transport_state
             WHEN 'DELIVERED' THEN 'DELIVERED'::openwa_message_transport_state
             WHEN 'READ' THEN 'READ'::openwa_message_transport_state
             WHEN 'FAILED' THEN 'FAILED_DEFINITIVE'::openwa_message_transport_state
             WHEN 'UNKNOWN' THEN 'INDETERMINATE'::openwa_message_transport_state
             ELSE message_attempts.transport_state
           END,
           transport_accepted_at = CASE WHEN EXCLUDED.outcome = 'ACCEPTED'
             THEN now() ELSE message_attempts.transport_accepted_at END,
           openwa_message_id = COALESCE($8, message_attempts.openwa_message_id)`,
        [id, attempt, status, JSON.stringify(options.response ?? null), options.error ?? null,
          updated.rows[0]?.current_upstream_started_at ?? null,
          updated.rows[0]?.safety_policy_version ?? null, options.openwaMessageId ?? null],
      );
    }
  }

}
