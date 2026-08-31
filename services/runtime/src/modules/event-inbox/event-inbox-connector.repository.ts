import {
  ConflictException,
  Inject,
  Injectable,
  OnModuleDestroy,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type {
  EventInboxConnectorHeartbeat,
  EventInboxConnectorStatusResponse,
} from '../../contracts/event-inbox';
import { EVENT_INBOX_CONFIG } from '../../core/event-inbox/event-inbox-config.module';
import { eventInboxConfig, type EventInboxConfig } from '../../core/event-inbox/event-inbox-config';
import type { EventInboxDeviceAuthorization } from './event-inbox-device.repository';

export interface EventInboxConnectorAuthorization {
  connectorId: string;
  deviceId: string;
  tokenGeneration: number;
  sessionIds: string[];
}

export interface EventInboxConnectorCredential {
  connectorId: string;
  token: string;
  sessionIds: string[];
}

export interface EventInboxPreparedConnectorCredential {
  connectorId: string;
  tokenGeneration: number;
  sessionIds: string[];
  outcome: 'CREATED' | 'UNCHANGED' | 'ROTATED';
}

export interface EventInboxConnectorBinding {
  sessionId: string;
  connectorId: string;
  webhookId: string;
  generation: number;
  updatedAt: string;
}

@Injectable()
export class EventInboxConnectorRepository implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(
    @Inject(EVENT_INBOX_CONFIG) private readonly config: EventInboxConfig = eventInboxConfig(),
  ) {
    this.pool = new Pool({
      connectionString: config.EVENT_INBOX_DATABASE_URL,
      max: 3,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
  }

  async provision(
    device: EventInboxDeviceAuthorization,
    sessionIds: string[],
  ): Promise<EventInboxConnectorCredential> {
    assertSessionSubset(device.sessionIds, sessionIds);
    const connectorId = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const tokenGeneration = 1;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertDeviceOwnsSessions(client, device.deviceId, device.tokenGeneration, sessionIds);
      const overlap = await client.query(
        `SELECT 1
         FROM event_inbox_connector_sessions AS scope
         JOIN event_inbox_connectors AS connector ON connector.connector_id = scope.connector_id
         WHERE connector.device_id = $1::uuid
           AND connector.revoked_at IS NULL
           AND scope.session_id = ANY($2::uuid[])
         LIMIT 1`,
        [device.deviceId, sessionIds],
      );
      if (overlap.rowCount) {
        throw new ConflictException('An active connector already owns this session');
      }
      await client.query(
        `INSERT INTO event_inbox_connectors
           (connector_id, device_id, token_generation, token_hash)
         VALUES ($1::uuid, $2::uuid, $3, $4)`,
        [connectorId, device.deviceId, tokenGeneration, this.tokenHash(secret)],
      );
      await client.query(
        `INSERT INTO event_inbox_connector_sessions (connector_id, session_id)
         SELECT $1::uuid, session_id FROM unnest($2::uuid[]) AS session(session_id)`,
        [connectorId, sessionIds],
      );
      await client.query('COMMIT');
      return {
        connectorId,
        token: encodeConnectorToken(connectorId, tokenGeneration, secret),
        sessionIds,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async putPreparedCredential(
    device: EventInboxDeviceAuthorization,
    connectorId: string,
    tokenGeneration: number,
    secretSha256: string,
    sessionIds: string[],
  ): Promise<EventInboxPreparedConnectorCredential> {
    assertSessionSubset(device.sessionIds, sessionIds);
    const verifier = Buffer.from(secretSha256, 'hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertDeviceOwnsSessions(client, device.deviceId, device.tokenGeneration, sessionIds);
      const existing = await client.query<{
        device_id: string;
        token_generation: string;
        token_hash: Buffer;
        token_hash_version: number;
        revoked_at: Date | null;
      }>(
        `SELECT device_id::text, token_generation::text, token_hash,
           token_hash_version, revoked_at
         FROM event_inbox_connectors
         WHERE connector_id = $1::uuid
         FOR UPDATE`,
        [connectorId],
      );
      const row = existing.rows[0];
      if (!row) {
        if (tokenGeneration !== 1) {
          throw new ConflictException('A new prepared connector credential must start at generation 1');
        }
        await this.assertNoActiveOverlap(client, device.deviceId, connectorId, sessionIds);
        await client.query(
          `INSERT INTO event_inbox_connectors
             (connector_id, device_id, token_generation, token_hash, token_hash_version)
           VALUES ($1::uuid, $2::uuid, $3, $4, 2)`,
          [connectorId, device.deviceId, tokenGeneration, verifier],
        );
        await client.query(
          `INSERT INTO event_inbox_connector_sessions (connector_id, session_id)
           SELECT $1::uuid, session_id FROM unnest($2::uuid[]) AS session(session_id)`,
          [connectorId, sessionIds],
        );
        await client.query('COMMIT');
        return { connectorId, tokenGeneration, sessionIds, outcome: 'CREATED' };
      }
      if (row.device_id !== device.deviceId) {
        throw new UnauthorizedException('Connector is not owned by this device');
      }
      const existingScope = await client.query<{ session_id: string }>(
        `SELECT session_id::text FROM event_inbox_connector_sessions
         WHERE connector_id = $1::uuid ORDER BY session_id`,
        [connectorId],
      );
      const storedSessionIds = existingScope.rows.map(scope => scope.session_id);
      const requestedSessionIds = [...sessionIds].sort();
      if (storedSessionIds.length !== requestedSessionIds.length
        || storedSessionIds.some((sessionId, index) => sessionId !== requestedSessionIds[index])) {
        throw new ConflictException('Prepared connector credential cannot change connector scope');
      }
      const currentGeneration = Number(row.token_generation);
      if (tokenGeneration === currentGeneration) {
        if (row.revoked_at || row.token_hash_version !== 2
          || row.token_hash.length !== verifier.length
          || !timingSafeEqual(row.token_hash, verifier)) {
          throw new ConflictException('Prepared connector credential conflicts with its generation');
        }
        await client.query('COMMIT');
        return { connectorId, tokenGeneration, sessionIds: storedSessionIds, outcome: 'UNCHANGED' };
      }
      if (tokenGeneration !== currentGeneration + 1) {
        throw new ConflictException('Prepared connector credential generation is not the next generation');
      }
      await this.assertNoActiveOverlap(client, device.deviceId, connectorId, sessionIds);
      await client.query(
        `UPDATE event_inbox_connectors
         SET token_generation = $2, token_hash = $3, token_hash_version = 2,
           rotated_at = now(), revoked_at = NULL
         WHERE connector_id = $1::uuid`,
        [connectorId, tokenGeneration, verifier],
      );
      await client.query('COMMIT');
      return { connectorId, tokenGeneration, sessionIds: storedSessionIds, outcome: 'ROTATED' };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async rotate(
    device: EventInboxDeviceAuthorization,
    connectorId: string,
  ): Promise<EventInboxConnectorCredential | null> {
    const secret = randomBytes(32).toString('base64url');
    const result = await this.pool.query<{
      token_generation: string;
      session_ids: string[];
    }>(
      `UPDATE event_inbox_connectors AS connector
       SET token_generation = connector.token_generation + 1,
         token_hash = $3,
         token_hash_version = 1,
         rotated_at = now(),
         revoked_at = NULL
       WHERE connector.connector_id = $1::uuid
         AND connector.device_id = $2::uuid
         AND NOT EXISTS (
           SELECT 1 FROM event_inbox_connector_sessions AS scope
           LEFT JOIN event_inbox_session_owners AS owner
             ON owner.session_id = scope.session_id
            AND owner.device_id = connector.device_id
            AND owner.token_generation = $4
           WHERE scope.connector_id = connector.connector_id
             AND owner.session_id IS NULL
         )
       RETURNING connector.token_generation::text,
         ARRAY(
           SELECT scope.session_id::text FROM event_inbox_connector_sessions AS scope
           WHERE scope.connector_id = connector.connector_id ORDER BY scope.session_id
         ) AS session_ids`,
      [connectorId, device.deviceId, this.tokenHash(secret), device.tokenGeneration],
    );
    const row = result.rows[0];
    if (!row) return null;
    const tokenGeneration = Number(row.token_generation);
    return {
      connectorId,
      token: encodeConnectorToken(connectorId, tokenGeneration, secret),
      sessionIds: row.session_ids,
    };
  }

  async revoke(device: EventInboxDeviceAuthorization, connectorId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE event_inbox_connectors
       SET revoked_at = now()
       WHERE connector_id = $1::uuid AND device_id = $2::uuid AND revoked_at IS NULL`,
      [connectorId, device.deviceId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async authenticate(authorization: string | undefined): Promise<EventInboxConnectorAuthorization> {
    const decoded = decodeConnectorToken(authorization);
    if (!decoded) throw this.unauthorized();
    const connector = await this.pool.query<{
      device_id: string;
      token_hash: Buffer;
      token_hash_version: number;
    }>(
      `SELECT device_id::text, token_hash, token_hash_version
       FROM event_inbox_connectors
       WHERE connector_id = $1::uuid AND token_generation = $2 AND revoked_at IS NULL`,
      [decoded.connectorId, decoded.tokenGeneration],
    );
    const row = connector.rows[0];
    const suppliedHash = row?.token_hash_version === 2
      ? createHash('sha256').update(decoded.secret).digest()
      : this.tokenHash(decoded.secret);
    if (!row || row.token_hash.length !== suppliedHash.length
      || !timingSafeEqual(row.token_hash, suppliedHash)) throw this.unauthorized();
    const sessions = await this.pool.query<{ session_id: string }>(
      `SELECT scope.session_id::text
       FROM event_inbox_connector_sessions AS scope
       JOIN event_inbox_connectors AS connector ON connector.connector_id = scope.connector_id
       JOIN event_inbox_session_owners AS owner
         ON owner.session_id = scope.session_id AND owner.device_id = connector.device_id
       JOIN event_inbox_devices AS device
         ON device.device_id = owner.device_id
        AND device.token_generation = owner.token_generation
        AND device.revoked_at IS NULL
        AND device.token_expires_at > now()
       WHERE scope.connector_id = $1::uuid
       ORDER BY scope.session_id`,
      [decoded.connectorId],
    );
    if (sessions.rows.length === 0) throw this.unauthorized();
    await this.pool.query(
      `UPDATE event_inbox_connectors SET last_authenticated_at = now()
       WHERE connector_id = $1::uuid
         AND (last_authenticated_at IS NULL OR last_authenticated_at < now() - interval '5 minutes')`,
      [decoded.connectorId],
    );
    return {
      connectorId: decoded.connectorId,
      deviceId: row.device_id,
      tokenGeneration: decoded.tokenGeneration,
      sessionIds: sessions.rows.map(session => session.session_id),
    };
  }

  async setBinding(
    device: EventInboxDeviceAuthorization,
    sessionId: string,
    connectorId: string,
    webhookId: string,
    generation: number,
  ): Promise<EventInboxConnectorBinding> {
    if (!device.sessionIds.includes(sessionId)) throw new UnauthorizedException('Session is not owned by this device');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertDeviceOwnsSessions(
        client,
        device.deviceId,
        device.tokenGeneration,
        [sessionId],
      );
      const result = await client.query<{
        session_id: string;
        connector_id: string;
        webhook_id: string;
        binding_generation: string;
        updated_at: Date;
      }>(
        `INSERT INTO event_inbox_connector_bindings
           (session_id, device_id, connector_id, webhook_id, binding_generation, updated_at)
         SELECT $1::uuid, $2::uuid, connector.connector_id, $4, $5, now()
         FROM event_inbox_connectors AS connector
         JOIN event_inbox_connector_sessions AS scope
           ON scope.connector_id = connector.connector_id AND scope.session_id = $1::uuid
         WHERE connector.connector_id = $3::uuid
           AND connector.device_id = $2::uuid
           AND connector.revoked_at IS NULL
         ON CONFLICT (session_id) DO UPDATE SET
           connector_id = EXCLUDED.connector_id,
           webhook_id = EXCLUDED.webhook_id,
           binding_generation = EXCLUDED.binding_generation,
           updated_at = CASE
             WHEN event_inbox_connector_bindings.binding_generation < EXCLUDED.binding_generation
               THEN now()
             ELSE event_inbox_connector_bindings.updated_at
           END
         WHERE event_inbox_connector_bindings.device_id = EXCLUDED.device_id
           AND (
             event_inbox_connector_bindings.binding_generation < EXCLUDED.binding_generation
             OR (
             event_inbox_connector_bindings.binding_generation = EXCLUDED.binding_generation
               AND event_inbox_connector_bindings.connector_id = EXCLUDED.connector_id
               AND event_inbox_connector_bindings.webhook_id = EXCLUDED.webhook_id
             )
           )
         RETURNING session_id::text, connector_id::text, webhook_id,
           binding_generation::text, updated_at`,
        [sessionId, device.deviceId, connectorId, webhookId, generation],
      );
      const row = result.rows[0];
      if (!row) {
        throw new ConflictException('Connector binding generation is stale or conflicts with an existing binding');
      }
      const history = await client.query(
        `INSERT INTO event_inbox_connector_binding_history
           (session_id, device_id, connector_id, webhook_id, binding_generation)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
         ON CONFLICT (session_id, binding_generation) DO UPDATE SET
           webhook_id = EXCLUDED.webhook_id
         WHERE event_inbox_connector_binding_history.device_id = EXCLUDED.device_id
           AND event_inbox_connector_binding_history.connector_id = EXCLUDED.connector_id
           AND event_inbox_connector_binding_history.webhook_id = EXCLUDED.webhook_id
         RETURNING session_id`,
        [sessionId, device.deviceId, connectorId, webhookId, generation],
      );
      if ((history.rowCount ?? 0) !== 1) {
        throw new ConflictException('Connector binding generation conflicts with retained history');
      }
      await client.query('COMMIT');
      return mapBinding(row);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordHeartbeat(
    connector: EventInboxConnectorAuthorization,
    heartbeat: EventInboxConnectorHeartbeat,
  ): Promise<EventInboxConnectorBinding[]> {
    assertSessionSubset(connector.sessionIds, heartbeat.sessions.map(session => session.sessionId));
    await this.pool.query(
      `INSERT INTO event_inbox_connector_heartbeats
         (connector_id, session_id, token_generation, plugin_version, protocol_version,
          journal_schema_version,
          reported_binding_generation, pending_count, oldest_pending_seconds,
          storage_utilization, blocked_reason, observed_at)
       SELECT $1::uuid, report.session_id, $2, $3, $4, $5,
         report.binding_generation, report.pending_count, report.oldest_pending_seconds,
         report.storage_utilization, report.blocked_reason, now()
       FROM jsonb_to_recordset($6::jsonb) AS report(
         session_id uuid,
         binding_generation bigint,
         pending_count bigint,
         oldest_pending_seconds bigint,
         storage_utilization double precision,
         blocked_reason text
       )
       JOIN event_inbox_connector_sessions AS scope
         ON scope.connector_id = $1::uuid AND scope.session_id = report.session_id
       ON CONFLICT (connector_id, session_id) DO UPDATE SET
         token_generation = EXCLUDED.token_generation,
         plugin_version = EXCLUDED.plugin_version,
         protocol_version = EXCLUDED.protocol_version,
         journal_schema_version = EXCLUDED.journal_schema_version,
         reported_binding_generation = EXCLUDED.reported_binding_generation,
         pending_count = EXCLUDED.pending_count,
         oldest_pending_seconds = EXCLUDED.oldest_pending_seconds,
         storage_utilization = EXCLUDED.storage_utilization,
         blocked_reason = EXCLUDED.blocked_reason,
         observed_at = now()`,
      [
        connector.connectorId,
        connector.tokenGeneration,
        heartbeat.pluginVersion,
        heartbeat.protocolVersion,
        heartbeat.journalSchemaVersion,
        JSON.stringify(heartbeat.sessions.map(session => ({
          session_id: session.sessionId,
          binding_generation: session.bindingGeneration,
          pending_count: session.pendingCount,
          oldest_pending_seconds: session.oldestPendingSeconds,
          storage_utilization: session.storageUtilization,
          blocked_reason: session.blockedReason,
        }))),
      ],
    );
    const bindings = await this.pool.query<{
      session_id: string;
      connector_id: string;
      webhook_id: string;
      binding_generation: string;
      updated_at: Date;
    }>(
      `SELECT binding.session_id::text, binding.connector_id::text, binding.webhook_id,
         binding.binding_generation::text, binding.updated_at
       FROM event_inbox_connector_bindings AS binding
       JOIN event_inbox_connector_sessions AS scope ON scope.session_id = binding.session_id
       WHERE scope.connector_id = $1::uuid AND binding.device_id = $2::uuid
         AND binding.connector_id = $1::uuid
       ORDER BY binding.session_id`,
      [connector.connectorId, connector.deviceId],
    );
    return bindings.rows.map(mapBinding);
  }

  async authorizeDelivery(
    connector: EventInboxConnectorAuthorization,
    sessionId: string,
    generation: number,
    deliveryId: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    if (!connector.sessionIds.includes(sessionId)) return false;
    const result = await this.pool.query<{ webhook_id: string }>(
      `SELECT binding.webhook_id
       FROM event_inbox_connector_binding_history AS binding
       WHERE binding.session_id = $1::uuid
         AND binding.device_id = $2::uuid
         AND binding.connector_id = $3::uuid
         AND binding.binding_generation = $4`,
      [sessionId, connector.deviceId, connector.connectorId, generation],
    );
    const webhookId = result.rows[0]?.webhook_id;
    return Boolean(webhookId && idempotencyKey === `${deliveryId}_${webhookId}`);
  }

  async status(device: EventInboxDeviceAuthorization): Promise<EventInboxConnectorStatusResponse['sessions']> {
    const result = await this.pool.query<{
      session_id: string;
      webhook_id: string | null;
      binding_connector_id: string | null;
      binding_generation: string | null;
      binding_updated_at: Date | null;
      connector_id: string | null;
      token_generation: string | null;
      plugin_version: string | null;
      protocol_version: number | null;
      journal_schema_version: number | null;
      reported_binding_generation: string | null;
      pending_count: string | null;
      oldest_pending_seconds: string | null;
      storage_utilization: number | null;
      blocked_reason: string | null;
      observed_at: Date | null;
    }>(
      `SELECT owner.session_id::text,
         binding.webhook_id, binding.connector_id::text AS binding_connector_id,
         binding.binding_generation::text,
         binding.updated_at AS binding_updated_at,
         latest.connector_id::text, latest.token_generation::text,
         latest.plugin_version, latest.protocol_version,
         latest.journal_schema_version, latest.reported_binding_generation::text,
         latest.pending_count::text, latest.oldest_pending_seconds::text,
         latest.storage_utilization, latest.blocked_reason, latest.observed_at
       FROM event_inbox_session_owners AS owner
       LEFT JOIN event_inbox_connector_bindings AS binding
         ON binding.session_id = owner.session_id AND binding.device_id = owner.device_id
       LEFT JOIN LATERAL (
         SELECT heartbeat.*
         FROM event_inbox_connector_heartbeats AS heartbeat
         JOIN event_inbox_connectors AS connector
           ON connector.connector_id = heartbeat.connector_id
          AND connector.device_id = owner.device_id
          AND connector.revoked_at IS NULL
         WHERE heartbeat.session_id = owner.session_id
           AND (binding.connector_id IS NULL OR heartbeat.connector_id = binding.connector_id)
         ORDER BY heartbeat.observed_at DESC, heartbeat.connector_id
         LIMIT 1
       ) AS latest ON true
       WHERE owner.device_id = $1::uuid AND owner.token_generation = $2
         AND owner.session_id = ANY($3::uuid[])
       ORDER BY owner.session_id`,
      [device.deviceId, device.tokenGeneration, device.sessionIds],
    );
    return result.rows.map(row => ({
      sessionId: row.session_id,
      binding: row.webhook_id && row.binding_connector_id
        && row.binding_generation && row.binding_updated_at
        ? {
          connectorId: row.binding_connector_id,
          webhookId: row.webhook_id,
          generation: Number(row.binding_generation),
          updatedAt: row.binding_updated_at.toISOString(),
        }
        : null,
      connector: row.connector_id && row.token_generation && row.plugin_version && row.protocol_version
        && row.journal_schema_version && row.reported_binding_generation
        && row.pending_count && row.storage_utilization !== null && row.observed_at
        ? {
          connectorId: row.connector_id,
          tokenGeneration: Number(row.token_generation),
          pluginVersion: row.plugin_version,
          protocolVersion: row.protocol_version,
          journalSchemaVersion: row.journal_schema_version,
          bindingGeneration: Number(row.reported_binding_generation),
          pendingCount: Number(row.pending_count),
          oldestPendingSeconds: row.oldest_pending_seconds === null
            ? null : Number(row.oldest_pending_seconds),
          storageUtilization: row.storage_utilization,
          blockedReason: row.blocked_reason,
          observedAt: row.observed_at.toISOString(),
        }
        : null,
    }));
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  private tokenHash(secret: string): Buffer {
    return createHmac('sha256', this.config.EVENT_INBOX_MASTER_SECRET)
      .update('event-inbox:connector-token:v1\0')
      .update(secret)
      .digest();
  }

  private unauthorized(): UnauthorizedException {
    return new UnauthorizedException('Invalid Event Inbox connector token');
  }

  private async assertDeviceOwnsSessions(
    client: PoolClient,
    deviceId: string,
    tokenGeneration: number,
    sessionIds: string[],
  ): Promise<void> {
    const result = await client.query<{ session_id: string }>(
      `SELECT session_id::text FROM event_inbox_session_owners
       WHERE device_id = $1::uuid AND token_generation = $2
         AND session_id = ANY($3::uuid[])
       FOR UPDATE`,
      [deviceId, tokenGeneration, sessionIds],
    );
    if (result.rows.length !== new Set(sessionIds).size) {
      throw new UnauthorizedException('Connector sessions are not owned by this device');
    }
  }

  private async assertNoActiveOverlap(
    client: PoolClient,
    deviceId: string,
    connectorId: string,
    sessionIds: string[],
  ): Promise<void> {
    const overlap = await client.query(
      `SELECT 1
       FROM event_inbox_connector_sessions AS scope
       JOIN event_inbox_connectors AS connector ON connector.connector_id = scope.connector_id
       WHERE connector.device_id = $1::uuid
         AND connector.connector_id <> $2::uuid
         AND connector.revoked_at IS NULL
         AND scope.session_id = ANY($3::uuid[])
       LIMIT 1`,
      [deviceId, connectorId, sessionIds],
    );
    if (overlap.rowCount) throw new ConflictException('An active connector already owns this session');
  }
}

function assertSessionSubset(allowed: string[], requested: string[]): void {
  const allowedSet = new Set(allowed);
  if (new Set(requested).size !== requested.length || requested.some(session => !allowedSet.has(session))) {
    throw new UnauthorizedException('Connector session scope is invalid');
  }
}

function encodeConnectorToken(connectorId: string, generation: number, secret: string): string {
  return `wac1.${connectorId}.${generation}.${secret}`;
}

function decodeConnectorToken(authorization: string | undefined): {
  connectorId: string;
  tokenGeneration: number;
  secret: string;
} | null {
  const supplied = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : undefined;
  if (!supplied || supplied.length > 4096) return null;
  const [prefix, connectorId, generation, secret, extra] = supplied.split('.');
  if (prefix !== 'wac1' || !connectorId || !generation || !secret || extra
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(connectorId)
    || !/^\d+$/u.test(generation) || !/^[A-Za-z0-9_-]{43}$/u.test(secret)) return null;
  const tokenGeneration = Number(generation);
  if (!Number.isSafeInteger(tokenGeneration) || tokenGeneration < 1) return null;
  return { connectorId, tokenGeneration, secret };
}

function mapBinding(row: {
  session_id: string;
  connector_id: string;
  webhook_id: string;
  binding_generation: string;
  updated_at: Date;
}): EventInboxConnectorBinding {
  return {
    sessionId: row.session_id,
    connectorId: row.connector_id,
    webhookId: row.webhook_id,
    generation: Number(row.binding_generation),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch {}
}
