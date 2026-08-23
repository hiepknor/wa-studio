import { resolve } from 'node:path';
import { Pool } from 'pg';
import { runtimeConfig } from '../config/runtime-config';
import { runMigrations, type MigrationRunResult } from './migration-runner';

export interface RuntimeMigrationOptions {
  databaseUrl?: string;
  directory?: string;
}

export async function migrateRuntimeDatabase(
  options: RuntimeMigrationOptions = {},
): Promise<MigrationRunResult> {
  const databaseUrl = options.databaseUrl ?? runtimeConfig().DATABASE_URL;
  const directory = options.directory
    ?? process.env.RUNTIME_MIGRATIONS_DIR
    ?? resolve(process.cwd(), 'migrations');
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    return await runMigrations(pool, directory);
  } finally {
    await pool.end();
  }
}
