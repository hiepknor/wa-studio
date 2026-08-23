import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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

export type EventInboxInsertResult = 'created' | 'duplicate' | 'capacity';

export interface EventInboxEnvelope {
  event: string;
  sessionId: string;
  idempotencyKey: string;
  deliveryId: string;
  [key: string]: unknown;
}

export interface EventInboxReadiness {
  storedEvents: number;
  storedBytes: number;
  pendingEvents: number;
  leasedEvents: number;
  deadEvents: number;
  oldestPendingAgeSeconds: number | null;
  activeDevices: number;
  legacyDevices: number;
  ownedSessions: number;
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
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const usage = await lockUsage(client);
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
        await client.query('COMMIT');
        return 'duplicate';
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

  async claim(
    deviceId: string,
    tokenGeneration: number,
    sessionIds: string[],
    limit: number,
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
         ORDER BY received_at, event.idempotency_key
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
      ],
    );
    return result.rows.map(row => ({
      idempotencyKey: row.idempotency_key,
      receiptHandle: encodeEventInboxReceipt({ idempotencyKey: row.idempotency_key, leaseId }),
      rawBody: row.raw_body.toString('base64'),
      signature: row.signature,
    }));
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
      const result = await client.query<{ storage_bytes: string }>(
        `DELETE FROM event_inbox_events AS event
         USING unnest($1::text[], $2::uuid[]) AS receipt(idempotency_key, lease_id)
         WHERE event.idempotency_key = receipt.idempotency_key
           AND event.lease_id = receipt.lease_id
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
         RETURNING event.storage_bytes::text`,
        [
          receipts.map(receipt => receipt.idempotencyKey),
          receipts.map(receipt => receipt.leaseId),
          deviceId,
          tokenGeneration,
        ],
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

  async readiness(): Promise<EventInboxReadiness> {
    const result = await this.pool.query<{
      stored_events: string;
      stored_bytes: string;
      pending_events: string;
      leased_events: string;
      dead_events: string;
      oldest_pending_age_seconds: string | null;
      active_devices: string;
      legacy_devices: string;
      owned_sessions: string;
    }>(
      `SELECT usage.stored_events::text, usage.stored_bytes::text,
         count(event.*) FILTER (WHERE event.dead_at IS NULL)::text AS pending_events,
         count(event.*) FILTER (WHERE event.dead_at IS NULL AND event.lease_expires_at > now())::text AS leased_events,
         count(event.*) FILTER (WHERE event.dead_at IS NOT NULL)::text AS dead_events,
         EXTRACT(EPOCH FROM now() - min(event.received_at) FILTER (WHERE event.dead_at IS NULL))::text
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
            AND device.token_expires_at > now()) AS owned_sessions
       FROM event_inbox_usage AS usage
       LEFT JOIN event_inbox_events AS event ON true
       WHERE usage.singleton = true
       GROUP BY usage.stored_events, usage.stored_bytes`,
    );
    const usage = result.rows[0];
    if (!usage) throw new Error('Event Inbox usage ledger is unavailable');
    return {
      storedEvents: Number(usage.stored_events),
      storedBytes: Number(usage.stored_bytes),
      pendingEvents: Number(usage.pending_events),
      leasedEvents: Number(usage.leased_events),
      deadEvents: Number(usage.dead_events),
      oldestPendingAgeSeconds: usage.oldest_pending_age_seconds === null
        ? null : Math.max(0, Math.round(Number(usage.oldest_pending_age_seconds))),
      activeDevices: Number(usage.active_devices),
      legacyDevices: Number(usage.legacy_devices),
      ownedSessions: Number(usage.owned_sessions),
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

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch {}
}
