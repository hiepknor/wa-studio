import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/core/database/migration-runner';
import { parseEventInboxConfig } from '../../src/core/event-inbox/event-inbox-config';
import { EventInboxRepository } from '../../src/modules/event-inbox/event-inbox.repository';
import { dropIsolatedDatabase, integrationPool } from '../support/integration-database';

const LAST_ACCEPTED_MIGRATION = 3;
const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const DEVICE_ID = '00000000-0000-4000-8000-000000000002';
const CONNECTOR_ID = '00000000-0000-4000-8000-000000000003';
const LEASE_ID = '00000000-0000-4000-8000-000000000004';
const IDEMPOTENCY_KEY = 'upgrade-event-1';

describe('Event Inbox release upgrade', () => {
  it('keeps the accepted primary safe after connector migrations and retained receipts', async () => {
    const admin = integrationPool();
    const databaseName = `wa_event_inbox_upgrade_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const oldMigrations = await mkdtemp(resolve(tmpdir(), 'wa-event-inbox-old-migrations-'));
    let upgrade: Pool | undefined;
    let repository: EventInboxRepository | undefined;
    try {
      expect(databaseName).toMatch(/^[a-z0-9_]+$/u);
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const databaseUrl = new URL(process.env.DATABASE_URL!);
      databaseUrl.pathname = `/${databaseName}`;
      upgrade = new Pool({ connectionString: databaseUrl.toString(), max: 3 });

      const migrations = resolve(process.cwd(), 'event-inbox-migrations');
      const files = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();
      const accepted = files.filter(name => Number(name.slice(0, 3)) <= LAST_ACCEPTED_MIGRATION);
      await Promise.all(accepted.map(name => copyFile(
        resolve(migrations, name),
        resolve(oldMigrations, name),
      )));
      expect((await runMigrations(upgrade, oldMigrations)).applied).toEqual(accepted);

      const rawBody = Buffer.from('{"event":"message.received"}', 'utf8');
      const signature = 'sha256=accepted-primary-signature';
      const storageBytes = rawBody.length + Buffer.byteLength(signature);
      await upgrade.query(
        `INSERT INTO event_inbox_devices
           (device_id, token_version, token_generation, paired_at, token_expires_at)
         VALUES ($1::uuid, 2, 1, now(), now() + interval '365 days')`,
        [DEVICE_ID],
      );
      await upgrade.query(
        `INSERT INTO event_inbox_session_owners
           (session_id, device_id, token_generation)
         VALUES ($1::uuid, $2::uuid, 1)`,
        [SESSION_ID, DEVICE_ID],
      );
      await upgrade.query(
        `INSERT INTO event_inbox_events
           (idempotency_key, delivery_id, event_type, session_id, raw_body, signature,
            expires_at, storage_bytes, lease_id, lease_owner, lease_generation,
            lease_expires_at, delivery_attempts)
         VALUES ($1, 'delivery-1', 'message.received', $2::uuid, $3, $4,
           now() + interval '7 days', $5, $6::uuid, $7::uuid, 1,
           now() + interval '1 minute', 1)`,
        [IDEMPOTENCY_KEY, SESSION_ID, rawBody, signature, storageBytes, LEASE_ID, DEVICE_ID],
      );
      await upgrade.query(
        `UPDATE event_inbox_usage
         SET stored_events = 1, stored_bytes = $1
         WHERE singleton`,
        [storageBytes],
      );

      const forward = files.filter(name => Number(name.slice(0, 3)) > LAST_ACCEPTED_MIGRATION);
      expect((await runMigrations(upgrade, migrations)).applied).toEqual(forward);
      expect(forward.at(-1)).toBe('014_event_inbox_active_lease_index.sql');
      const hotPathIndexes = await upgrade.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = current_schema()
           AND indexname = ANY($1::text[])
         ORDER BY indexname`,
        [[
          'idx_event_inbox_events_lease_active',
          'idx_event_inbox_events_received_active',
          'idx_event_inbox_events_session_received_active',
        ]],
      );
      expect(hotPathIndexes.rows.map(row => row.indexname)).toEqual([
        'idx_event_inbox_events_lease_active',
        'idx_event_inbox_events_received_active',
        'idx_event_inbox_events_session_received_active',
      ]);
      expect(await runMigrations(upgrade, migrations)).toEqual({
        applied: [],
        checksumsBackfilled: [],
      });

      repository = new EventInboxRepository(parseEventInboxConfig({
        NODE_ENV: 'test',
        EVENT_INBOX_DATABASE_URL: databaseUrl.toString(),
        EVENT_INBOX_MASTER_SECRET: 'upgrade-test-master-secret-with-at-least-32-characters',
        EVENT_INBOX_PUBLIC_BASE_URL: 'http://127.0.0.1:34200',
        EVENT_INBOX_OPENWA_BASE_URL: 'http://127.0.0.1:2785',
        EVENT_INBOX_ALLOWED_SESSION_IDS: SESSION_ID,
      }));
      await expect(repository.acknowledge(DEVICE_ID, 1, [{
        idempotencyKey: IDEMPOTENCY_KEY,
        leaseId: LEASE_ID,
      }])).resolves.toBe(1);

      const legacyRetry = await upgrade.connect();
      try {
        await legacyRetry.query('BEGIN');
        await legacyRetry.query(
          'SELECT stored_events FROM event_inbox_usage WHERE singleton FOR UPDATE',
        );
        const inserted = await legacyRetry.query(
          `INSERT INTO event_inbox_events
             (idempotency_key, delivery_id, event_type, session_id, raw_body, signature,
              expires_at, storage_bytes)
           VALUES ($1, 'delivery-retry', 'message.received', $2::uuid, $3, $4,
             now() + interval '7 days', $5)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING 1`,
          [IDEMPOTENCY_KEY, SESSION_ID, rawBody, signature, storageBytes],
        );
        expect(inserted.rowCount).toBe(0);
        const newEvent = await legacyRetry.query(
          `INSERT INTO event_inbox_events
             (idempotency_key, delivery_id, event_type, session_id, raw_body, signature,
              expires_at, storage_bytes)
           VALUES ('upgrade-event-2', 'delivery-2', 'message.received', $1::uuid, $2, $3,
             now() + interval '7 days', $4)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING 1`,
          [SESSION_ID, rawBody, signature, storageBytes],
        );
        expect(newEvent.rowCount).toBe(1);
        await legacyRetry.query(
          `UPDATE event_inbox_usage
           SET stored_events = stored_events + 1, stored_bytes = stored_bytes + $1
           WHERE singleton`,
          [storageBytes],
        );
        await legacyRetry.query('COMMIT');
      } catch (error) {
        await legacyRetry.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        legacyRetry.release();
      }
      expect((await upgrade.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM event_inbox_events WHERE idempotency_key = $1',
        [IDEMPOTENCY_KEY],
      )).rows[0]?.count).toBe('0');
      expect((await upgrade.query<{ payload_hash: Buffer }>(
        'SELECT payload_hash FROM event_inbox_receipts WHERE idempotency_key = $1',
        [IDEMPOTENCY_KEY],
      )).rows[0]?.payload_hash).toEqual(createHash('sha256').update(rawBody).digest());

      await seedConnectorOwnership(upgrade);
      await upgrade.query(
        `UPDATE event_inbox_devices
         SET revoked_at = now(), token_expires_at = now() - interval '1 second'
         WHERE device_id = $1::uuid`,
        [DEVICE_ID],
      );
      await upgrade.query(
        `DELETE FROM event_inbox_session_owners AS owner
         USING event_inbox_devices AS device
         WHERE device.device_id = owner.device_id
           AND (device.revoked_at IS NOT NULL
             OR device.token_expires_at <= now()
             OR owner.token_generation <> device.token_generation)`,
      );
      await expect(upgrade.query(
        `DELETE FROM event_inbox_devices AS device
         WHERE device.token_expires_at <= now()
           AND NOT EXISTS (
             SELECT 1 FROM event_inbox_session_owners AS owner
             WHERE owner.device_id = device.device_id
           )`,
      )).resolves.toMatchObject({ rowCount: 1 });
      for (const table of [
        'event_inbox_connectors',
        'event_inbox_connector_sessions',
        'event_inbox_connector_bindings',
        'event_inbox_connector_binding_history',
        'event_inbox_connector_heartbeats',
      ]) {
        expect((await upgrade.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table}`,
        )).rows[0]?.count).toBe('0');
      }
    } finally {
      await repository?.onModuleDestroy().catch(() => undefined);
      await upgrade?.end().catch(() => undefined);
      try {
        await dropIsolatedDatabase(admin, databaseName);
      } finally {
        await admin.end();
        await rm(oldMigrations, { recursive: true, force: true });
      }
    }
  }, 30_000);
});

async function seedConnectorOwnership(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO event_inbox_connectors
       (connector_id, device_id, token_generation, token_hash, token_hash_version)
     VALUES ($1::uuid, $2::uuid, 1, $3, 2)`,
    [CONNECTOR_ID, DEVICE_ID, Buffer.alloc(32, 1)],
  );
  await pool.query(
    `INSERT INTO event_inbox_connector_sessions (connector_id, session_id)
     VALUES ($1::uuid, $2::uuid)`,
    [CONNECTOR_ID, SESSION_ID],
  );
  await pool.query(
    `INSERT INTO event_inbox_connector_bindings
       (session_id, device_id, connector_id, webhook_id, binding_generation)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'webhook-1', 1)`,
    [SESSION_ID, DEVICE_ID, CONNECTOR_ID],
  );
  await pool.query(
    `INSERT INTO event_inbox_connector_binding_history
       (session_id, device_id, connector_id, webhook_id, binding_generation)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'webhook-1', 1)`,
    [SESSION_ID, DEVICE_ID, CONNECTOR_ID],
  );
  await pool.query(
    `INSERT INTO event_inbox_connector_heartbeats
       (connector_id, session_id, token_generation, plugin_version, protocol_version,
        journal_schema_version, reported_binding_generation, pending_count,
        storage_utilization)
     VALUES ($1::uuid, $2::uuid, 1, '0.1.0', 1, 1, 1, 0, 0.1)`,
    [CONNECTOR_ID, SESSION_ID],
  );
}
