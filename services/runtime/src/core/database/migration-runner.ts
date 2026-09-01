import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';

const MIGRATION_LOCK_NAME = 'wa-runtime:schema-migrations';

export interface MigrationRunResult {
  applied: string[];
  checksumsBackfilled: string[];
}

export type MigrationDatabaseState = 'empty' | 'managed' | 'untracked';

export interface MigrationPlan {
  databaseState: MigrationDatabaseState;
  pending: string[];
  checksumsBackfill: string[];
  currentFingerprint: string;
  targetFingerprint: string;
  requiresBackup: boolean;
}

interface MigrationFile {
  name: string;
  checksum: string;
  contents: string;
}

const checksum = (contents: string): string => createHash('sha256').update(contents).digest('hex');
const fingerprint = (entries: Array<{ name: string; checksum: string | null }>): string =>
  createHash('sha256').update(JSON.stringify(entries)).digest('hex');

async function migrationFiles(directory: string): Promise<MigrationFile[]> {
  const files = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  return Promise.all(files.map(async name => {
    const contents = await readFile(resolve(directory, name), 'utf8');
    return { name, contents, checksum: checksum(contents) };
  }));
}

export async function planMigrations(pool: Pool, directory: string): Promise<MigrationPlan> {
  const client = await pool.connect();
  try {
    const files = await migrationFiles(directory);
    const table = await client.query<{ exists: boolean }>(
      `SELECT to_regclass(current_schema() || '.schema_migrations') IS NOT NULL AS exists`,
    );
    if (!table.rows[0]?.exists) {
      const userTables = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_tables WHERE schemaname = current_schema()
         ) AS exists`,
      );
      const databaseState = userTables.rows[0]?.exists ? 'untracked' : 'empty';
      return {
        databaseState,
        pending: files.map(file => file.name),
        checksumsBackfill: [],
        currentFingerprint: fingerprint([]),
        targetFingerprint: fingerprint(files),
        requiresBackup: databaseState === 'untracked' && files.length > 0,
      };
    }

    const checksumColumn = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'schema_migrations'
           AND column_name = 'checksum'
       ) AS exists`,
    );
    const recorded = checksumColumn.rows[0]?.exists
      ? await client.query<{ name: string; checksum: string | null }>(
        `SELECT name, checksum FROM schema_migrations WHERE name LIKE '%.sql' ORDER BY name`,
      )
      : await client.query<{ name: string; checksum: null }>(
        `SELECT name, NULL::text AS checksum
         FROM schema_migrations WHERE name LIKE '%.sql' ORDER BY name`,
      );
    return buildMigrationPlan(files, recorded.rows);
  } finally {
    client.release();
  }
}

function buildMigrationPlan(
  files: MigrationFile[],
  recorded: Array<{ name: string; checksum: string | null }>,
): MigrationPlan {
  const available = new Map(files.map(file => [file.name, file]));
  const applied = new Map(recorded.map(row => [row.name, row]));
  const missing = recorded.find(row => !available.has(row.name));
  if (missing) throw new Error(`Applied migration file missing: ${missing.name}`);

  const checksumsBackfill: string[] = [];
  for (const row of recorded) {
    const current = available.get(row.name)!;
    if (row.checksum === null) checksumsBackfill.push(row.name);
    else if (row.checksum !== current.checksum) {
      throw new Error(`Applied migration checksum mismatch: ${row.name}`);
    }
  }
  const pending = files.filter(file => !applied.has(file.name)).map(file => file.name);
  return {
    databaseState: 'managed',
    pending,
    checksumsBackfill,
    currentFingerprint: fingerprint(recorded),
    targetFingerprint: fingerprint(files),
    requiresBackup: pending.length > 0,
  };
}

export async function runMigrations(pool: Pool, directory: string): Promise<MigrationRunResult> {
  const client = await pool.connect();
  let locked = false;
  const result: MigrationRunResult = { applied: [], checksumsBackfilled: [] };
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [MIGRATION_LOCK_NAME]);
    locked = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text');

    const files = await migrationFiles(directory);
    const availableFiles = new Set(files.map(file => file.name));
    const recorded = await client.query<{ name: string }>(
      "SELECT name FROM schema_migrations WHERE name LIKE '%.sql' ORDER BY name",
    );
    const missing = recorded.rows.find(row => !availableFiles.has(row.name));
    if (missing) throw new Error(`Applied migration file missing: ${missing.name}`);

    for (const file of files) {
      const existing = await client.query<{ checksum: string | null }>(
        'SELECT checksum FROM schema_migrations WHERE name = $1', [file.name],
      );
      if (existing.rowCount) {
        const recordedChecksum = existing.rows[0]!.checksum;
        if (recordedChecksum === null) {
          await client.query('UPDATE schema_migrations SET checksum = $2 WHERE name = $1', [file.name, file.checksum]);
          result.checksumsBackfilled.push(file.name);
          continue;
        }
        if (recordedChecksum !== file.checksum) {
          throw new Error(`Applied migration checksum mismatch: ${file.name}`);
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(file.contents);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
          [file.name, file.checksum],
        );
        await client.query('COMMIT');
        result.applied.push(file.name);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return result;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK_NAME]);
    client.release();
  }
}
