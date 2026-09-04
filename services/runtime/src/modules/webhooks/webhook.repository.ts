import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { DatabaseService } from '../../core/database/database.service';
import {
  decrementRuntimeWebhookSpoolUsage,
  incrementRuntimeWebhookSpoolUsage,
  lockRuntimeWebhookSpoolUsage,
  runtimeWebhookSpoolAdmission,
} from '../../core/database/runtime-webhook-spool';

export interface OpenWAWebhookEnvelope {
  event: string;
  timestamp: string;
  sessionId: string;
  idempotencyKey: string;
  deliveryId: string;
  data: Record<string, unknown>;
}

export interface WebhookDispatchItem {
  idempotencyKey: string;
}

export interface ClaimedWebhook {
  envelope: OpenWAWebhookEnvelope;
  leaseToken: string;
  attemptNumber: number;
}

export type WebhookAttemptResult = 'RETRY' | 'DEAD' | 'LOST_OWNERSHIP';

export class WebhookSpoolCapacityError extends Error {
  constructor() {
    super('Runtime webhook spool capacity is exhausted');
    this.name = 'WebhookSpoolCapacityError';
  }
}

const webhookIdempotencyLockNamespace = 748_231;

function envelopeHash(envelope: OpenWAWebhookEnvelope): string {
  return createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
}

@Injectable()
export class WebhookRepository {
  constructor(
    private readonly database: DatabaseService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async insert(envelope: OpenWAWebhookEnvelope): Promise<boolean> {
    const payload = JSON.stringify(envelope);
    const payloadSha256 = envelopeHash(envelope);
    const storageBytes = Buffer.byteLength(payload, 'utf8');
    return this.database.transaction(async client => {
      await this.lockIdempotencyKey(client, envelope.idempotencyKey);
      const receipt = await client.query(
        `SELECT 1 FROM webhook_event_receipts WHERE idempotency_key = $1`,
        [envelope.idempotencyKey],
      );
      if (receipt.rowCount) return false;
      const existing = await client.query(
        `SELECT 1 FROM webhook_events WHERE idempotency_key = $1`,
        [envelope.idempotencyKey],
      );
      if (existing.rowCount) return false;
      const usage = await lockRuntimeWebhookSpoolUsage(client);
      if (!runtimeWebhookSpoolAdmission(usage, this.config, storageBytes)) {
        throw new WebhookSpoolCapacityError();
      }
      const result = await client.query(
        `INSERT INTO webhook_events
           (idempotency_key, delivery_id, event_type, session_id, payload, payload_sha256,
            storage_bytes)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [
          envelope.idempotencyKey,
          envelope.deliveryId,
          envelope.event,
          envelope.sessionId,
          payload,
          payloadSha256,
          storageBytes,
        ],
      );
      await incrementRuntimeWebhookSpoolUsage(client, storageBytes);
      return result.rowCount === 1;
    });
  }

  async find(idempotencyKey: string): Promise<OpenWAWebhookEnvelope | null> {
    const result = await this.database.query<{ payload: OpenWAWebhookEnvelope }>(
      'SELECT payload FROM webhook_events WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    return result.rows[0]?.payload ?? null;
  }

  async listDispatchable(limit: number): Promise<WebhookDispatchItem[]> {
    const result = await this.database.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM webhook_events
       WHERE processing_state IN ('PENDING', 'RETRY') AND attempt_count < 5 AND next_attempt_at <= now()
       ORDER BY next_attempt_at, received_at LIMIT $1`,
      [limit],
    );
    return result.rows.map(row => ({ idempotencyKey: row.idempotency_key }));
  }

  async claimForProcessing(idempotencyKey: string): Promise<ClaimedWebhook | null> {
    const result = await this.database.query<{
      payload: OpenWAWebhookEnvelope;
      lease_token: string;
      attempt_count: number;
    }>(
      `UPDATE webhook_events SET processing_state = 'PROCESSING',
         attempt_count = attempt_count + 1, last_attempt_at = now(),
         lease_token = gen_random_uuid(), lease_expires_at = now() + interval '2 minutes',
         processing_error = NULL
       WHERE idempotency_key = $1
         AND processing_state IN ('PENDING', 'RETRY')
         AND attempt_count < 5
         AND next_attempt_at <= now()
       RETURNING payload, lease_token, attempt_count`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row ? { envelope: row.payload, leaseToken: row.lease_token, attemptNumber: row.attempt_count } : null;
  }

  async recoverExpiredProcessing(): Promise<number> {
    const result = await this.database.query(
      `UPDATE webhook_events SET
         processing_state = CASE WHEN attempt_count >= 5 THEN 'DEAD' ELSE 'RETRY' END,
         lease_token = NULL, lease_expires_at = NULL,
         next_attempt_at = CASE WHEN attempt_count >= 5 THEN next_attempt_at ELSE now() END,
         dead_at = CASE WHEN attempt_count >= 5 THEN now() ELSE dead_at END,
         processing_error = 'Recovered expired processing lease'
       WHERE processing_state = 'PROCESSING' AND lease_expires_at < now()`,
    );
    return result.rowCount ?? 0;
  }

  async markProcessed(idempotencyKey: string, leaseToken: string, error?: string): Promise<boolean> {
    return this.database.transaction(async client => {
      if (!await this.lockProcessingLease(client, idempotencyKey, leaseToken)) return false;
      return this.markProcessedInTransaction(client, idempotencyKey, leaseToken, error);
    });
  }

  async lockProcessingLease(client: PoolClient, idempotencyKey: string, leaseToken: string): Promise<boolean> {
    await this.lockIdempotencyKey(client, idempotencyKey);
    const result = await client.query(
      `SELECT 1 FROM webhook_events
       WHERE idempotency_key = $1 AND processing_state = 'PROCESSING' AND lease_token = $2
         AND lease_expires_at > now()
       FOR UPDATE`,
      [idempotencyKey, leaseToken],
    );
    return result.rowCount === 1;
  }

  async markProcessedInTransaction(
    client: PoolClient,
    idempotencyKey: string,
    leaseToken: string,
    error?: string,
  ): Promise<boolean> {
    // The idempotency lock is already held by lockProcessingLease. Take the
    // global usage row only for the terminal write so unrelated projections
    // do not serialize for their full transaction.
    await lockRuntimeWebhookSpoolUsage(client);
    if (this.config.RUNTIME_COMPACT_PROCESSED_WEBHOOK_PAYLOAD_ENABLED) {
      const result = await client.query<{
        delivery_id: string | null;
        event_type: string;
        session_id: string | null;
        payload_sha256: string | null;
        received_at: Date;
        storage_bytes: string;
      }>(
        `DELETE FROM webhook_events
         WHERE idempotency_key = $1 AND processing_state = 'PROCESSING' AND lease_token = $2
           AND lease_expires_at > now()
         RETURNING delivery_id, event_type, session_id, payload_sha256, received_at,
           storage_bytes::text`,
        [idempotencyKey, leaseToken],
      );
      const processed = result.rows[0];
      if (!processed) return false;
      await client.query(
        `INSERT INTO webhook_event_receipts
           (idempotency_key, delivery_id, event_type, session_id, payload_sha256,
            received_at, processed_at, processing_error, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now(), $7,
           now() + ($8::text || ' days')::interval)`,
        [
          idempotencyKey,
          processed.delivery_id,
          processed.event_type,
          processed.session_id,
          processed.payload_sha256,
          processed.received_at,
          error ?? null,
          this.config.RUNTIME_RAW_WEBHOOK_RETENTION_DAYS,
        ],
      );
      await decrementRuntimeWebhookSpoolUsage(client, 1, Number(processed.storage_bytes));
      return true;
    }
    const result = await client.query<{ storage_bytes: string }>(
      `UPDATE webhook_events
       SET processing_state = 'PROCESSED', processed_at = now(), processing_error = $2,
         lease_token = NULL, lease_expires_at = NULL,
         payload = CASE WHEN $4::boolean THEN jsonb_build_object(
             'event', event_type,
             'timestamp', payload->'timestamp',
             'sessionId', session_id,
             'idempotencyKey', idempotency_key,
             'deliveryId', delivery_id,
             'data', '{}'::jsonb
           ) ELSE payload END
       WHERE idempotency_key = $1 AND processing_state = 'PROCESSING' AND lease_token = $3
         AND lease_expires_at > now()
       RETURNING storage_bytes::text`,
      [idempotencyKey, error ?? null, leaseToken,
        this.config.RUNTIME_COMPACT_PROCESSED_WEBHOOK_PAYLOAD_ENABLED],
    );
    const processed = result.rows[0];
    if (!processed) return false;
    await decrementRuntimeWebhookSpoolUsage(client, 1, Number(processed.storage_bytes));
    return true;
  }

  async markFailed(idempotencyKey: string, leaseToken: string, error: string): Promise<WebhookAttemptResult> {
    const result = await this.database.query<{ processing_state: 'RETRY' | 'DEAD' }>(
      `UPDATE webhook_events SET
         processing_state = CASE WHEN attempt_count >= 5 THEN 'DEAD' ELSE 'RETRY' END,
         processing_error = $2,
         lease_token = NULL, lease_expires_at = NULL,
         next_attempt_at = CASE WHEN attempt_count >= 5 THEN next_attempt_at
           ELSE now() + LEAST(300, 5 * power(2, attempt_count - 1)) * interval '1 second' END,
         dead_at = CASE WHEN attempt_count >= 5 THEN now() ELSE dead_at END
       WHERE idempotency_key = $1 AND processing_state = 'PROCESSING' AND lease_token = $3
         AND lease_expires_at > now()
       RETURNING processing_state`,
      [idempotencyKey, error, leaseToken],
    );
    return result.rows[0]?.processing_state ?? 'LOST_OWNERSHIP';
  }

  private async lockIdempotencyKey(client: PoolClient, idempotencyKey: string): Promise<void> {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, $2))',
      [idempotencyKey, webhookIdempotencyLockNamespace],
    );
  }
}
