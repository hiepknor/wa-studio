import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/core/database/migration-runner';
import { dropIsolatedDatabase, integrationPool } from '../support/integration-database';

const LAST_RELEASED_MIGRATION = 51;
const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const SECOND_SESSION_ID = '00000000-0000-4000-8000-000000000002';
const GROUP_ID = '120363000000000000@g.us';

describe('release upgrade', () => {
  it('upgrades a populated migration-051 database and preserves durable evidence', async () => {
    const admin = integrationPool();
    const databaseName = `wa_runtime_upgrade_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const oldMigrations = await mkdtemp(resolve(tmpdir(), 'wa-runtime-old-migrations-'));
    let upgrade: Pool | undefined;
    try {
      expect(databaseName).toMatch(/^[a-z0-9_]+$/u);
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const databaseUrl = new URL(process.env.DATABASE_URL!);
      databaseUrl.pathname = `/${databaseName}`;
      upgrade = new Pool({ connectionString: databaseUrl.toString(), max: 2 });

      const migrations = resolve(process.cwd(), 'migrations');
      const files = (await readdir(migrations))
        .filter(name => name.endsWith('.sql'))
        .sort();
      const released = files.filter(name => Number(name.slice(0, 3)) <= LAST_RELEASED_MIGRATION);
      await Promise.all(released.map(name => copyFile(
        resolve(migrations, name),
        resolve(oldMigrations, name),
      )));
      expect((await runMigrations(upgrade, oldMigrations)).applied).toEqual(released);

      await upgrade.query(
        `INSERT INTO gateway_sessions
           (id, name, status, engine_loaded, gateway_created_at, gateway_updated_at)
         VALUES ($1, 'Upgrade primary', 'ready', true, now(), now()),
                ($2, 'Upgrade secondary', 'ready', true, now(), now())`,
        [SESSION_ID, SECOND_SESSION_ID],
      );
      await upgrade.query(
        `INSERT INTO gateway_groups
           (session_id, id, name, is_active, send_capability, send_capability_reason,
            capability_checked_at)
         VALUES ($1, $2, 'Upgrade group', true, 'ALLOWED', 'SEND_ALLOWED', now())`,
        [SESSION_ID, GROUP_ID],
      );
      const sync = await upgrade.query<{ id: string }>(
        `INSERT INTO sync_runs
           (session_id, sync_type, status, phase, requested_at, completed_at)
         VALUES ($1, 'FULL', 'COMPLETED', 'DISCOVERING', now() - interval '1 day', now())
         RETURNING id`,
        [SESSION_ID],
      );
      await upgrade.query(
        `INSERT INTO gateway_group_reconciliation_intents
           (session_id, group_id, requested_revision, completed_revision, reasons, status,
            first_requested_at, last_requested_at, completed_at, updated_at)
         VALUES ($1, $2, 2, 2, ARRAY['manual.capability_refresh'], 'COMPLETED',
           now() - interval '1 day', now(), now(), now())`,
        [SESSION_ID, GROUP_ID],
      );
      await upgrade.query(
        `INSERT INTO message_jobs
           (idempotency_scope, idempotency_key, request_hash, session_id, recipient_id,
            payload, scheduled_at, status, dry_run, openwa_message_id)
         VALUES ('runtime-api', 'upgrade-message-1', $1, $2, $4,
                  '{"type":"TEXT","text":"one"}', now(), 'ACCEPTED', false, 'shared-message-id'),
                ('runtime-api', 'upgrade-message-2', $1, $3, $4,
                  '{"type":"TEXT","text":"two"}', now(), 'ACCEPTED', false, 'shared-message-id')`,
        ['a'.repeat(64), SESSION_ID, SECOND_SESSION_ID, GROUP_ID],
      );

      const expectedForward = files.filter(name => Number(name.slice(0, 3)) > LAST_RELEASED_MIGRATION);
      expect((await runMigrations(upgrade, migrations)).applied).toEqual(expectedForward);
      expect(await runMigrations(upgrade, migrations)).toEqual({ applied: [], checksumsBackfilled: [] });

      expect((await upgrade.query<{ status: string; phase: string; completed_at: Date | null }>(
        `SELECT status, phase, completed_at FROM sync_runs WHERE id = $1`,
        [sync.rows[0]!.id],
      )).rows[0]).toMatchObject({ status: 'COMPLETED', phase: 'COMPLETED' });
      expect((await upgrade.query<{
        request_revision: string; source: string; status: string; completed_at: Date | null;
      }>(
        `SELECT request_revision::text, source, status, completed_at
         FROM gateway_group_reconciliation_operations
         WHERE session_id = $1 AND group_id = $2`,
        [SESSION_ID, GROUP_ID],
      )).rows).toEqual([
        expect.objectContaining({ request_revision: '2', source: 'MANUAL', status: 'COMPLETED' }),
      ]);
      expect((await upgrade.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM message_jobs WHERE openwa_message_id = 'shared-message-id'`,
      )).rows[0]?.count).toBe('2');
      await expect(upgrade.query(
        `UPDATE sync_runs SET status = 'RUNNING', phase = 'RECONCILING', completed_at = NULL
         WHERE id = $1`,
        [sync.rows[0]!.id],
      )).rejects.toMatchObject({ code: '23514' });
      await expect(upgrade.query(
        `INSERT INTO message_jobs
           (idempotency_scope, idempotency_key, request_hash, session_id, recipient_id,
            payload, scheduled_at, status, dry_run, openwa_message_id)
         VALUES ('runtime-api', 'upgrade-message-duplicate', $1, $2, $3,
           '{"type":"TEXT","text":"duplicate"}', now(), 'ACCEPTED', false, 'shared-message-id')`,
        ['b'.repeat(64), SESSION_ID, GROUP_ID],
      )).rejects.toMatchObject({ code: '23505' });
    } finally {
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
