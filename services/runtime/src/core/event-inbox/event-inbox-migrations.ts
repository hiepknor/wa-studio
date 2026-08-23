import { Pool } from 'pg';
import { resolve } from 'node:path';
import { runMigrations } from '../database/migration-runner';
import { eventInboxConfig, type EventInboxConfig } from './event-inbox-config';

export async function migrateEventInboxDatabase(
  config: EventInboxConfig = eventInboxConfig(),
): Promise<void> {
  const pool = new Pool({ connectionString: config.EVENT_INBOX_DATABASE_URL, max: 1 });
  try {
    await runMigrations(pool, resolve(process.cwd(), 'event-inbox-migrations'));
  } finally {
    await pool.end();
  }
}
