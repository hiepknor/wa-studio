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
  attempt_count: number;
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
  attemptCount: row.attempt_count,
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
    return this.database.transaction(async client => {
      const result = await client.query<MessageJobRow>(
        `SELECT * FROM message_jobs
         WHERE status = 'SCHEDULED' AND scheduled_at <= now()
         ORDER BY scheduled_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        [limit],
      );
      if (!result.rows.length) return [];
      const ids = result.rows.map(row => row.id);
      await client.query(
        `UPDATE message_jobs SET status = 'QUEUED', updated_at = now() WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      return result.rows.map(row => map({ ...row, status: 'QUEUED' }));
    });
  }

  async markProcessing(id: string): Promise<MessageJob | null> {
    const result = await this.database.query<MessageJobRow>(
      `UPDATE message_jobs
       SET status = 'PROCESSING', attempt_count = attempt_count + 1,
         processing_started_at = now(), lease_expires_at = now() + interval '2 minutes', updated_at = now()
       WHERE id = $1 AND status = 'QUEUED'
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
    const updated = await client.query<MessageJobRow>(
      `UPDATE message_jobs SET status = 'SCHEDULED', scheduled_at = now() + $3 * interval '1 millisecond',
         last_error = $2, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'PROCESSING'
       RETURNING attempt_count`,
      [id, error, delayMs],
    );
    const attempt = updated.rows[0]?.attempt_count;
    if (attempt === undefined) return false;
    await client.query(
      `INSERT INTO message_attempts (message_job_id, attempt_number, outcome, error)
       VALUES ($1, $2, 'RETRY', $3)
       ON CONFLICT (message_job_id, attempt_number) DO NOTHING`,
      [id, attempt, error],
    );
    return true;
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
    const result = await this.database.query<{ count: string }>(
      `WITH expired AS (
         UPDATE message_jobs SET status = 'UNKNOWN',
           last_error = 'Processing lease expired; delivery outcome is unknown',
           lease_expires_at = NULL, updated_at = now()
         WHERE status = 'PROCESSING' AND lease_expires_at < now()
         RETURNING id, attempt_count
       ), attempts AS (
         INSERT INTO message_attempts (message_job_id, attempt_number, outcome, error)
         SELECT id, attempt_count, 'UNKNOWN', 'Processing lease expired; delivery outcome is unknown'
         FROM expired ON CONFLICT (message_job_id, attempt_number) DO NOTHING
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
       RETURNING attempt_count`,
      [id, status, options.openwaMessageId ?? null, options.error ?? null],
    );
    const attempt = updated.rows[0]?.attempt_count;
    if (attempt !== undefined) {
      await client.query(
        `INSERT INTO message_attempts (message_job_id, attempt_number, outcome, response, error)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (message_job_id, attempt_number) DO NOTHING`,
        [id, attempt, status, JSON.stringify(options.response ?? null), options.error ?? null],
      );
    }
  }

}
