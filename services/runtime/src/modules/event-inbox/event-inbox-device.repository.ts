import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import type { EventInboxDeviceClaims } from '../../core/event-inbox/event-inbox-token.service';
import { EVENT_INBOX_CONFIG } from '../../core/event-inbox/event-inbox-config.module';
import { eventInboxConfig, type EventInboxConfig } from '../../core/event-inbox/event-inbox-config';

export interface EventInboxDevicePairing {
  deviceId: string;
  tokenGeneration: number;
  issuedAt: Date;
  expiresAt: Date;
  sessionIds: string[];
}

export interface EventInboxDeviceAuthorization {
  deviceId: string;
  tokenGeneration: number;
  tokenVersion: 1 | 2;
  sessionIds: string[];
}

export interface EventInboxDeviceCleanupResult {
  sessionFences: number;
  devices: number;
}

@Injectable()
export class EventInboxDeviceRepository implements OnModuleDestroy {
  private readonly pool: Pool;
  private readonly allowedSessions: Set<string>;

  constructor(
    @Inject(EVENT_INBOX_CONFIG) private readonly config: EventInboxConfig = eventInboxConfig(),
  ) {
    this.allowedSessions = new Set(config.EVENT_INBOX_ALLOWED_SESSION_IDS);
    this.pool = new Pool({
      connectionString: config.EVENT_INBOX_DATABASE_URL,
      max: 3,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
  }

  async pair(deviceId: string, sessionIds: string[]): Promise<EventInboxDevicePairing> {
    const client = await this.pool.connect();
    const expiresAt = new Date(
      Date.now() + this.config.EVENT_INBOX_DEVICE_TOKEN_TTL_DAYS * 86_400_000,
    );
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('wa-event-inbox:device-ownership'))",
      );
      const device = await client.query<{
        token_generation: string;
        paired_at: Date;
        token_expires_at: Date;
      }>(
        `INSERT INTO event_inbox_devices
           (device_id, token_version, token_generation, paired_at, token_expires_at, revoked_at)
         VALUES ($1::uuid, 2, 1, now(), $2, NULL)
         ON CONFLICT (device_id) DO UPDATE SET
           token_version = 2,
           token_generation = GREATEST(1, event_inbox_devices.token_generation + 1),
           paired_at = now(),
           token_expires_at = EXCLUDED.token_expires_at,
           revoked_at = NULL
         RETURNING token_generation::text, paired_at, token_expires_at`,
        [deviceId, expiresAt],
      );
      const current = device.rows[0];
      if (!current) throw new Error('Event Inbox device pairing did not return a token generation');
      const tokenGeneration = Number(current.token_generation);
      await client.query(
        `INSERT INTO event_inbox_session_owners
           (session_id, device_id, token_generation, acquired_at)
         SELECT session_id, $2::uuid, $3, now()
         FROM unnest($1::uuid[]) AS session(session_id)
         ON CONFLICT (session_id) DO UPDATE SET
           device_id = EXCLUDED.device_id,
           token_generation = EXCLUDED.token_generation,
           acquired_at = EXCLUDED.acquired_at`,
        [sessionIds, deviceId, tokenGeneration],
      );
      await releaseLeases(client, deviceId, sessionIds);
      await client.query('COMMIT');
      return {
        deviceId,
        tokenGeneration,
        issuedAt: new Date(current.paired_at),
        expiresAt: new Date(current.token_expires_at),
        sessionIds,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async authorize(claims: EventInboxDeviceClaims): Promise<EventInboxDeviceAuthorization | null> {
    return claims.version === 2
      ? this.authorizeV2(claims.deviceId, claims.tokenGeneration, claims.expiresAt)
      : this.authorizeLegacy(claims.deviceId, claims.sessionIds);
  }

  async revoke(deviceId: string, tokenGeneration: number): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const revoked = await client.query(
        `UPDATE event_inbox_devices
         SET revoked_at = now()
         WHERE device_id = $1::uuid AND token_generation = $2 AND revoked_at IS NULL
         RETURNING 1`,
        [deviceId, tokenGeneration],
      );
      if (revoked.rowCount) await releaseLeases(client, deviceId, []);
      await client.query('COMMIT');
      return (revoked.rowCount ?? 0) > 0;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async cleanupInactive(): Promise<EventInboxDeviceCleanupResult> {
    const acceptUntil = this.config.EVENT_INBOX_V1_ACCEPT_UNTIL;
    if (acceptUntil && Date.parse(acceptUntil) > Date.now()) {
      return { sessionFences: 0, devices: 0 };
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('wa-event-inbox:device-ownership'))",
      );
      await client.query(
        `UPDATE event_inbox_events AS event
         SET lease_id = NULL, lease_owner = NULL, lease_generation = NULL,
           lease_expires_at = NULL
         FROM event_inbox_devices AS device
         WHERE event.lease_owner = device.device_id
           AND (device.revoked_at IS NOT NULL
             OR device.token_expires_at <= now()
             OR event.lease_generation <> device.token_generation)`,
      );
      const fences = await client.query(
        `DELETE FROM event_inbox_session_owners AS owner
         USING event_inbox_devices AS device
         WHERE device.device_id = owner.device_id
           AND (device.revoked_at IS NOT NULL
             OR device.token_expires_at <= now()
             OR owner.token_generation <> device.token_generation)
         RETURNING 1`,
      );
      const devices = await client.query(
        `DELETE FROM event_inbox_devices AS device
         WHERE device.token_expires_at <= now()
           AND NOT EXISTS (
             SELECT 1 FROM event_inbox_session_owners AS owner
             WHERE owner.device_id = device.device_id
           )
         RETURNING 1`,
      );
      await client.query('COMMIT');
      return {
        sessionFences: fences.rowCount ?? 0,
        devices: devices.rowCount ?? 0,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async authorizeV2(
    deviceId: string,
    tokenGeneration: number,
    expiresAt: string,
  ): Promise<EventInboxDeviceAuthorization | null> {
    const result = await this.pool.query<{ session_id: string }>(
      `SELECT owner.session_id::text
       FROM event_inbox_devices AS device
       JOIN event_inbox_session_owners AS owner
         ON owner.device_id = device.device_id
        AND owner.token_generation = device.token_generation
       WHERE device.device_id = $1::uuid
         AND device.token_version = 2
         AND device.token_generation = $2
         AND device.token_expires_at = $3::timestamptz
         AND device.token_expires_at > now()
         AND device.revoked_at IS NULL
       ORDER BY owner.session_id`,
      [deviceId, tokenGeneration, expiresAt],
    );
    if (result.rows.length === 0) return null;
    await this.markAuthenticated(deviceId, tokenGeneration);
    return {
      deviceId,
      tokenGeneration,
      tokenVersion: 2,
      sessionIds: result.rows.map(row => row.session_id),
    };
  }

  private async authorizeLegacy(
    deviceId: string,
    claimedSessionIds: string[],
  ): Promise<EventInboxDeviceAuthorization | null> {
    const acceptUntil = this.config.EVENT_INBOX_V1_ACCEPT_UNTIL;
    if (!acceptUntil || Date.parse(acceptUntil) <= Date.now()) return null;
    const sessionIds = claimedSessionIds.filter(id => this.allowedSessions.has(id));
    if (sessionIds.length === 0) return null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('wa-event-inbox:device-ownership'))",
      );
      await client.query(
        `INSERT INTO event_inbox_devices
           (device_id, token_version, token_generation, paired_at, token_expires_at)
         VALUES ($1::uuid, 1, 0, now(), $2::timestamptz)
         ON CONFLICT (device_id) DO NOTHING`,
        [deviceId, acceptUntil],
      );
      const legacy = await client.query(
        `SELECT 1 FROM event_inbox_devices
         WHERE device_id = $1::uuid AND token_version = 1
           AND token_generation = 0 AND token_expires_at > now() AND revoked_at IS NULL`,
        [deviceId],
      );
      if (!legacy.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(
        `INSERT INTO event_inbox_session_owners
           (session_id, device_id, token_generation, acquired_at)
         SELECT session_id, $2::uuid, 0, now()
         FROM unnest($1::uuid[]) AS session(session_id)
         ON CONFLICT (session_id) DO NOTHING`,
        [sessionIds, deviceId],
      );
      const owned = await client.query<{ session_id: string }>(
        `SELECT session_id::text FROM event_inbox_session_owners
         WHERE device_id = $1::uuid AND token_generation = 0
           AND session_id = ANY($2::uuid[])
         ORDER BY session_id`,
        [deviceId, sessionIds],
      );
      if (owned.rows.length > 0) {
        await client.query(
          `UPDATE event_inbox_devices SET last_authenticated_at = now()
           WHERE device_id = $1::uuid`,
          [deviceId],
        );
      }
      await client.query('COMMIT');
      if (owned.rows.length === 0) return null;
      return {
        deviceId,
        tokenGeneration: 0,
        tokenVersion: 1,
        sessionIds: owned.rows.map(row => row.session_id),
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async markAuthenticated(deviceId: string, tokenGeneration: number): Promise<void> {
    await this.pool.query(
      `UPDATE event_inbox_devices SET last_authenticated_at = now()
       WHERE device_id = $1::uuid AND token_generation = $2
         AND (last_authenticated_at IS NULL
           OR last_authenticated_at < now() - interval '5 minutes')`,
      [deviceId, tokenGeneration],
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

async function releaseLeases(
  client: PoolClient,
  deviceId: string,
  sessionIds: string[],
): Promise<void> {
  await client.query(
    `UPDATE event_inbox_events
     SET lease_id = NULL, lease_owner = NULL, lease_generation = NULL,
       lease_expires_at = NULL
     WHERE lease_owner = $1::uuid OR session_id = ANY($2::uuid[])`,
    [deviceId, sessionIds],
  );
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch {}
}
