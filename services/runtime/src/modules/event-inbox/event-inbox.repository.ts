import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { EventInboxEvent, EventInboxNack } from '../../contracts/event-inbox';
import { EVENT_INBOX_CONFIG } from '../../core/event-inbox/event-inbox-config.module';
import { eventInboxConfig, type EventInboxConfig } from '../../core/event-inbox/event-inbox-config';
import { encodeEventInboxReceipt, type EventInboxReceipt } from './event-inbox-receipt';

const ACTIVE_DEVICE_OWNERSHIP_SQL = `EXISTS (
  SELECT 1 FROM event_inbox_session_owners AS owner
  JOIN event_inbox_devices AS device
    ON device.device_id = owner.device_id
   AND device.token_generation = owner.token_generation
   AND device.revoked_at IS NULL
   AND device.token_expires_at > now()
  WHERE owner.session_id = event_inbox_events.session_id
    AND owner.device_id = $4::uuid AND owner.token_generation = $5
)`;

export type EventInboxInsertResult = 'created' | 'duplicate' | 'conflict' | 'capacity';

export interface EventInboxEnvelope {
  event: string;
  sessionId: string;
  idempotencyKey: string;
  deliveryId: string;
  [key: string]: unknown;
}

export interface EventInboxReadiness {
  migrationHead: string;
  migrationCount: number;
  storedEvents: number;
  storedBytes: number;
  pendingEvents: number;
  leasedEvents: number;
  deadEvents: number;
  retainedReceipts: number;
  oldestPendingAgeSeconds: number | null;
  activeDevices: number;
  legacyDevices: number;
  ownedSessions: number;
  activeRateLimitBuckets: number;
  rateLimitedPairingAttempts: number;
  maxStoredEvents: number;
  maxStoredBytes: number;
}

@Injectable()
export class EventInboxRepository implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(
    @Inject(EVENT_INBOX_CONFIG) private readonly config: EventInboxConfig = eventInboxConfig(),
  ) {
    this.pool = new Pool({
      connectionString: config.EVENT_INBOX_DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
  }

  async insert(
    rawBody: Buffer,
    signature: string,
    envelope: EventInboxEnvelope,
  ): Promise<EventInboxInsertResult> {
    const storageBytes = rawBody.length + Buffer.byteLength(signature, 'utf8');
    const hash = payloadHash(rawBody);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const usage = await lockUsage(client);
      const receipt = await client.query<{ payload_hash: Buffer }>(
        `SELECT payload_hash FROM event_inbox_receipts
         WHERE idempotency_key = $1 AND expires_at > now()`,
        [envelope.idempotencyKey],
      );
      if (receipt.rowCount) {
        await client.query('COMMIT');
        return receipt.rows[0]!.payload_hash.equals(hash) ? 'duplicate' : 'conflict';
      }
      const inserted = await client.query(
        `INSERT INTO event_inbox_events
           (idempotency_key, delivery_id, event_type, session_id, raw_body, signature,
            expires_at, storage_bytes)
         VALUES ($1, $2, $3, $4::uuid, $5, $6,
           now() + ($7::text || ' days')::interval, $8)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING 1`,
        [
          envelope.idempotencyKey,
          envelope.deliveryId,
          envelope.event,
          envelope.sessionId,
          rawBody,
          signature,
          this.config.EVENT_INBOX_RETENTION_DAYS,
          storageBytes,
        ],
      );
      if (!inserted.rowCount) {
        const existing = await client.query<{ raw_body: Buffer }>(
          'SELECT raw_body FROM event_inbox_events WHERE idempotency_key = $1',
          [envelope.idempotencyKey],
        );
        await client.query('COMMIT');
        return existing.rows[0] && payloadHash(existing.rows[0].raw_body).equals(hash)
          ? 'duplicate'
          : 'conflict';
      }
      if (usage.storedEvents + 1 > this.config.EVENT_INBOX_MAX_STORED_EVENTS
        || usage.storedBytes + storageBytes > this.config.EVENT_INBOX_MAX_STORED_BYTES) {
        await client.query('ROLLBACK');
        return 'capacity';
      }
      await client.query(
        `UPDATE event_inbox_usage
         SET stored_events = stored_events + 1, stored_bytes = stored_bytes + $1
         WHERE singleton = true`,
        [storageBytes],
      );
      await client.query('COMMIT');
      return 'created';
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async consumeRateLimit(
    scope: string,
    keyHash: Buffer,
    maxAttempts: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const result = await this.pool.query<{
      attempts: string;
      retry_after_seconds: string;
    }>(
      `INSERT INTO event_inbox_rate_limits
         (scope, key_hash, window_started_at, attempts, blocked_attempts, expires_at)
       VALUES ($1, $2, now(), 1, 0, now() + ($4::text || ' seconds')::interval)
       ON CONFLICT (scope, key_hash) DO UPDATE SET
         window_started_at = CASE
           WHEN event_inbox_rate_limits.expires_at <= now() THEN now()
           ELSE event_inbox_rate_limits.window_started_at
         END,
         attempts = CASE
           WHEN event_inbox_rate_limits.expires_at <= now() THEN 1
           ELSE event_inbox_rate_limits.attempts + 1
         END,
         blocked_attempts = CASE
           WHEN event_inbox_rate_limits.expires_at <= now() THEN 0
           WHEN event_inbox_rate_limits.attempts + 1 > $3
             THEN event_inbox_rate_limits.blocked_attempts + 1
           ELSE event_inbox_rate_limits.blocked_attempts
         END,
         expires_at = CASE
           WHEN event_inbox_rate_limits.expires_at <= now()
             THEN now() + ($4::text || ' seconds')::interval
           ELSE event_inbox_rate_limits.expires_at
         END
       RETURNING attempts::text,
         GREATEST(1, CEIL(EXTRACT(EPOCH FROM expires_at - now())))::bigint::text
           AS retry_after_seconds`,
      [scope, keyHash, maxAttempts, windowSeconds],
    );
    const bucket = result.rows[0];
    if (!bucket) throw new Error('Event Inbox rate limit did not return a decision');
    return {
      allowed: Number(bucket.attempts) <= maxAttempts,
      retryAfterSeconds: Number(bucket.retry_after_seconds),
    };
  }

  async claim(
    deviceId: string,
    tokenGeneration: number,
    sessionIds: string[],
    limit: number,
    throughSequence?: string,
  ): Promise<EventInboxEvent[]> {
    const leaseId = randomUUID();
    const result = await this.pool.query<{
      idempotency_key: string;
      raw_body: Buffer;
      signature: string;
    }>(
      `WITH candidates AS (
         SELECT event.idempotency_key
         FROM event_inbox_events AS event
         JOIN event_inbox_session_owners AS owner
           ON owner.session_id = event.session_id
          AND owner.device_id = $4::uuid
          AND owner.token_generation = $5
         JOIN event_inbox_devices AS device
           ON device.device_id = owner.device_id
          AND device.token_generation = owner.token_generation
          AND device.revoked_at IS NULL
          AND device.token_expires_at > now()
         WHERE event.session_id = ANY($1::uuid[])
           AND dead_at IS NULL
           AND expires_at > now()
           AND available_at <= now()
           AND (lease_expires_at IS NULL OR lease_expires_at <= now())
           AND ($7::bigint IS NULL OR event.event_sequence <= $7::bigint)
         ORDER BY event.event_sequence
         FOR UPDATE OF event SKIP LOCKED
         LIMIT $2
       )
       UPDATE event_inbox_events AS event
         SET lease_id = $3::uuid,
         lease_owner = $4::uuid,
         lease_generation = $5,
         lease_expires_at = now() + ($6::text || ' seconds')::interval,
         delivery_attempts = event.delivery_attempts + 1
       FROM candidates
       WHERE event.idempotency_key = candidates.idempotency_key
       RETURNING event.idempotency_key, event.raw_body, event.signature`,
      [
        sessionIds,
        Math.min(limit, this.config.EVENT_INBOX_CLAIM_BATCH_MAX),
        leaseId,
        deviceId,
        tokenGeneration,
        this.config.EVENT_INBOX_LEASE_SECONDS,
        throughSequence ?? null,
      ],
    );
    return result.rows.map(row => ({
      idempotencyKey: row.idempotency_key,
      receiptHandle: encodeEventInboxReceipt({ idempotencyKey: row.idempotency_key, leaseId }),
      rawBody: row.raw_body.toString('base64'),
      signature: row.signature,
    }));
  }

  async recovery(
    deviceId: string,
    tokenGeneration: number,
    sessionIds: string[],
    requestedWatermark?: string,
  ): Promise<{ watermark: string; remaining: number }> {
    const result = await this.pool.query<{
      watermark: string;
      remaining: string;
    }>(
      `WITH owned_events AS (
         SELECT event.event_sequence
         FROM event_inbox_events AS event
         JOIN event_inbox_session_owners AS owner
           ON owner.session_id = event.session_id
          AND owner.device_id = $2::uuid
          AND owner.token_generation = $3
         JOIN event_inbox_devices AS device
           ON device.device_id = owner.device_id
          AND device.token_generation = owner.token_generation
          AND device.revoked_at IS NULL
          AND device.token_expires_at > now()
         WHERE event.session_id = ANY($1::uuid[])
           AND event.dead_at IS NULL
           AND event.expires_at > now()
       ), watermark AS (
         SELECT COALESCE($4::bigint, max(event_sequence), 0) AS value
         FROM owned_events
       )
       SELECT watermark.value::text AS watermark,
         count(owned_events.event_sequence)::text AS remaining
       FROM watermark
       LEFT JOIN owned_events ON owned_events.event_sequence <= watermark.value
       GROUP BY watermark.value`,
      [sessionIds, deviceId, tokenGeneration, requestedWatermark ?? null],
    );
    const recovery = result.rows[0];
    if (!recovery) throw new Error('Event Inbox recovery watermark is unavailable');
    return { watermark: recovery.watermark, remaining: Number(recovery.remaining) };
  }

  async acknowledge(
    deviceId: string,
    tokenGeneration: number,
    receipts: EventInboxReceipt[],
  ): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockUsage(client);
      await lockIdempotencyKeys(
        client,
        receipts.map(receipt => receipt.idempotencyKey),
      );
      const selected = await client.query<{
        idempotency_key: string;
        session_id: string;
        raw_body: Buffer;
      }>(
        `SELECT event.idempotency_key, event.session_id::text, event.raw_body
         FROM event_inbox_events AS event
         JOIN unnest($1::text[], $2::uuid[]) AS receipt(idempotency_key, lease_id)
           ON event.idempotency_key = receipt.idempotency_key
          AND event.lease_id = receipt.lease_id
         WHERE event.idempotency_key = receipt.idempotency_key
           AND event.lease_owner = $3::uuid
           AND event.lease_generation = $4
           AND EXISTS (
             SELECT 1 FROM event_inbox_session_owners AS owner
             JOIN event_inbox_devices AS device
               ON device.device_id = owner.device_id
              AND device.token_generation = owner.token_generation
              AND device.revoked_at IS NULL
              AND device.token_expires_at > now()
             WHERE owner.session_id = event.session_id
               AND owner.device_id = $3::uuid AND owner.token_generation = $4
           )
         FOR UPDATE OF event`,
        [
          receipts.map(receipt => receipt.idempotencyKey),
          receipts.map(receipt => receipt.leaseId),
          deviceId,
          tokenGeneration,
        ],
      );
      if (selected.rowCount) {
        await client.query(
          `DELETE FROM event_inbox_receipts
           WHERE idempotency_key = ANY($1::text[]) AND expires_at <= now()
           RETURNING 1`,
          [selected.rows.map(row => row.idempotency_key)],
        );
        await client.query(
          `INSERT INTO event_inbox_receipts
             (idempotency_key, session_id, payload_hash, expires_at)
           SELECT receipt.idempotency_key, receipt.session_id, receipt.payload_hash,
             now() + ($4::text || ' days')::interval
           FROM unnest($1::text[], $2::uuid[], $3::bytea[])
             AS receipt(idempotency_key, session_id, payload_hash)
           ON CONFLICT (idempotency_key) DO UPDATE SET
             session_id = EXCLUDED.session_id,
             payload_hash = EXCLUDED.payload_hash,
             accepted_at = now(),
             expires_at = EXCLUDED.expires_at
           WHERE event_inbox_receipts.expires_at <= now()
           RETURNING 1`,
          [
            selected.rows.map(row => row.idempotency_key),
            selected.rows.map(row => row.session_id),
            selected.rows.map(row => payloadHash(row.raw_body)),
            this.config.EVENT_INBOX_RECEIPT_RETENTION_DAYS,
          ],
        );
      }
      const result = await client.query<{ storage_bytes: string }>(
        `DELETE FROM event_inbox_events
         WHERE idempotency_key = ANY($1::text[])
         RETURNING storage_bytes::text`,
        [selected.rows.map(row => row.idempotency_key)],
      );
      await decrementUsage(client, result.rows);
      await client.query('COMMIT');
      return result.rowCount ?? 0;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async negativelyAcknowledge(
    deviceId: string,
    tokenGeneration: number,
    items: Array<EventInboxNack & EventInboxReceipt>,
  ): Promise<{ retried: number; dead: number }> {
    const client = await this.pool.connect();
    let retried = 0;
    let dead = 0;
    try {
      await client.query('BEGIN');
      for (const item of items) {
        const result = item.disposition === 'dead'
          ? await client.query(
            `UPDATE event_inbox_events
             SET dead_at = now(), dead_reason = $1,
               lease_id = NULL, lease_owner = NULL, lease_generation = NULL,
               lease_expires_at = NULL
             WHERE idempotency_key = $2 AND lease_id = $3::uuid AND lease_owner = $4::uuid
               AND lease_generation = $5
               AND ${ACTIVE_DEVICE_OWNERSHIP_SQL}
             RETURNING true AS dead`,
            [
              item.reason ?? 'consumer_rejected',
              item.idempotencyKey,
              item.leaseId,
              deviceId,
              tokenGeneration,
            ],
          )
          : await client.query<{ dead: boolean }>(
            `UPDATE event_inbox_events
             SET dead_at = CASE WHEN delivery_attempts >= $1 THEN now() ELSE NULL END,
               dead_reason = CASE WHEN delivery_attempts >= $1 THEN 'max_delivery_attempts' ELSE NULL END,
               available_at = CASE WHEN delivery_attempts >= $1 THEN available_at
                 ELSE now() + (LEAST(300, power(2, GREATEST(0, delivery_attempts - 1)))::text || ' seconds')::interval END,
               lease_id = NULL, lease_owner = NULL, lease_generation = NULL,
               lease_expires_at = NULL
             WHERE idempotency_key = $2 AND lease_id = $3::uuid AND lease_owner = $4::uuid
               AND lease_generation = $5
               AND ${ACTIVE_DEVICE_OWNERSHIP_SQL}
             RETURNING dead_at IS NOT NULL AS dead`,
            [
              this.config.EVENT_INBOX_MAX_DELIVERY_ATTEMPTS,
              item.idempotencyKey,
              item.leaseId,
              deviceId,
              tokenGeneration,
            ],
          );
        if (result.rowCount) {
          if ((result.rows[0] as { dead?: boolean } | undefined)?.dead) dead += 1;
          else retried += 1;
        }
      }
      await client.query('COMMIT');
      return { retried, dead };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async removeExpired(limit: number): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockUsage(client);
      const result = await client.query<{ storage_bytes: string }>(
        `DELETE FROM event_inbox_events
         WHERE idempotency_key IN (
           SELECT idempotency_key FROM event_inbox_events
           WHERE expires_at <= now()
           ORDER BY expires_at, idempotency_key
           FOR UPDATE SKIP LOCKED LIMIT $1
         )
         RETURNING storage_bytes::text`,
        [limit],
      );
      await decrementUsage(client, result.rows);
      await client.query('COMMIT');
      return result.rowCount ?? 0;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async removeExpiredRateLimits(limit: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM event_inbox_rate_limits
       WHERE (scope, key_hash) IN (
         SELECT scope, key_hash FROM event_inbox_rate_limits
         WHERE expires_at <= now()
         ORDER BY expires_at, scope, key_hash
         LIMIT $1
       )`,
      [limit],
    );
    return result.rowCount ?? 0;
  }

  async removeExpiredReceipts(limit: number): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockUsage(client);
      const result = await client.query(
        `DELETE FROM event_inbox_receipts
         WHERE idempotency_key IN (
           SELECT idempotency_key FROM event_inbox_receipts
           WHERE expires_at <= now()
           ORDER BY expires_at, idempotency_key
           LIMIT $1
         )
         RETURNING 1`,
        [limit],
      );
      await client.query('COMMIT');
      return result.rowCount ?? 0;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async readiness(): Promise<EventInboxReadiness> {
    const result = await this.pool.query<{
      stored_events: string;
      stored_bytes: string;
      pending_events: string;
      leased_events: string;
      dead_events: string;
      retained_receipts: string;
      oldest_pending_age_seconds: string | null;
      active_devices: string;
      legacy_devices: string;
      owned_sessions: string;
      active_rate_limit_buckets: string;
      rate_limited_pairing_attempts: string;
      migration_head: string | null;
      migration_count: string;
    }>(
      `SELECT usage.stored_events::text, usage.stored_bytes::text,
         GREATEST(0, usage.stored_events - state.dead_events)::text AS pending_events,
         state.leased_events::text,
         state.dead_events::text,
         usage.retained_receipts::text,
         EXTRACT(EPOCH FROM now() - state.oldest_pending_at)::text
           AS oldest_pending_age_seconds,
         (SELECT count(*)::text FROM event_inbox_devices AS device
          WHERE device.revoked_at IS NULL AND device.token_expires_at > now()
            AND EXISTS (
              SELECT 1 FROM event_inbox_session_owners AS owner
              WHERE owner.device_id = device.device_id
                AND owner.token_generation = device.token_generation
            )) AS active_devices,
         (SELECT count(*)::text FROM event_inbox_devices
          WHERE token_version = 1 AND revoked_at IS NULL
            AND token_expires_at > now()) AS legacy_devices,
         (SELECT count(*)::text FROM event_inbox_session_owners AS owner
          JOIN event_inbox_devices AS device
            ON device.device_id = owner.device_id
           AND device.token_generation = owner.token_generation
          WHERE device.revoked_at IS NULL
            AND device.token_expires_at > now()) AS owned_sessions,
         (SELECT count(*)::text FROM event_inbox_rate_limits
          WHERE expires_at > now()) AS active_rate_limit_buckets,
         (SELECT COALESCE(sum(blocked_attempts), 0)::text FROM event_inbox_rate_limits
          WHERE expires_at > now()) AS rate_limited_pairing_attempts,
         (SELECT name FROM schema_migrations
          WHERE name LIKE '%.sql' ORDER BY name DESC LIMIT 1) AS migration_head,
         (SELECT count(*)::text FROM schema_migrations
          WHERE name LIKE '%.sql') AS migration_count
       FROM event_inbox_usage AS usage
       CROSS JOIN LATERAL (
         SELECT
           (SELECT count(*) FROM event_inbox_events
            WHERE dead_at IS NOT NULL) AS dead_events,
           (SELECT count(*) FROM event_inbox_events
            WHERE dead_at IS NULL AND lease_expires_at > now()) AS leased_events,
           (SELECT min(received_at) FROM event_inbox_events
            WHERE dead_at IS NULL) AS oldest_pending_at
       ) AS state
       WHERE usage.singleton = true
      `,
    );
    const usage = result.rows[0];
    if (!usage || !usage.migration_head) {
      throw new Error('Event Inbox usage or migration ledger is unavailable');
    }
    return {
      migrationHead: usage.migration_head,
      migrationCount: Number(usage.migration_count),
      storedEvents: Number(usage.stored_events),
      storedBytes: Number(usage.stored_bytes),
      pendingEvents: Number(usage.pending_events),
      leasedEvents: Number(usage.leased_events),
      deadEvents: Number(usage.dead_events),
      retainedReceipts: Number(usage.retained_receipts),
      oldestPendingAgeSeconds: usage.oldest_pending_age_seconds === null
        ? null : Math.max(0, Math.round(Number(usage.oldest_pending_age_seconds))),
      activeDevices: Number(usage.active_devices),
      legacyDevices: Number(usage.legacy_devices),
      ownedSessions: Number(usage.owned_sessions),
      activeRateLimitBuckets: Number(usage.active_rate_limit_buckets),
      rateLimitedPairingAttempts: Number(usage.rate_limited_pairing_attempts),
      maxStoredEvents: this.config.EVENT_INBOX_MAX_STORED_EVENTS,
      maxStoredBytes: this.config.EVENT_INBOX_MAX_STORED_BYTES,
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

async function lockUsage(client: PoolClient): Promise<{ storedEvents: number; storedBytes: number }> {
  const result = await client.query<{ stored_events: string; stored_bytes: string }>(
    `SELECT stored_events::text, stored_bytes::text
     FROM event_inbox_usage WHERE singleton = true FOR UPDATE`,
  );
  const usage = result.rows[0];
  if (!usage) throw new Error('Event Inbox usage ledger is unavailable');
  return { storedEvents: Number(usage.stored_events), storedBytes: Number(usage.stored_bytes) };
}

async function decrementUsage(
  client: PoolClient,
  removed: Array<{ storage_bytes: string }>,
): Promise<void> {
  if (removed.length === 0) return;
  const removedBytes = removed.reduce((total, row) => total + Number(row.storage_bytes), 0);
  await client.query(
    `UPDATE event_inbox_usage
     SET stored_events = GREATEST(0, stored_events - $1),
       stored_bytes = GREATEST(0, stored_bytes - $2)
     WHERE singleton = true`,
    [removed.length, removedBytes],
  );
}

async function lockIdempotencyKeys(client: PoolClient, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended(idempotency_key, 0))
     FROM (
       SELECT DISTINCT idempotency_key
       FROM unnest($1::text[]) AS requested(idempotency_key)
       ORDER BY idempotency_key
     ) AS ordered_keys`,
    [keys],
  );
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch {}
}

function payloadHash(rawBody: Buffer): Buffer {
  return createHash('sha256').update(rawBody).digest();
}
