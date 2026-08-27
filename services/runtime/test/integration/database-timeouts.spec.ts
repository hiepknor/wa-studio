import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseRuntimeConfig } from '../../src/core/config/runtime-config';
import { DatabaseService } from '../../src/core/database/database.service';

describe('PostgreSQL failure bounds', () => {
  let database: DatabaseService;

  beforeAll(() => {
    database = new DatabaseService(parseRuntimeConfig({
      ...process.env,
      DATABASE_POOL_MAX: '1',
      DATABASE_QUERY_TIMEOUT_MS: '1000',
    }));
  });

  afterAll(async () => {
    await database.onApplicationShutdown();
  });

  it('cancels an over-budget statement and keeps the pool usable', async () => {
    const startedAt = Date.now();

    await expect(database.query('SELECT pg_sleep(5)')).rejects.toBeDefined();
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    await expect(database.query<{ ready: number }>('SELECT 1 AS ready'))
      .resolves.toMatchObject({ rows: [{ ready: 1 }] });
  });
});
