import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { RuntimeConfig } from '../../src/core/config/runtime-config';
import { DatabaseService } from '../../src/core/database/database.service';

const databaseConfig = (): RuntimeConfig => ({
  DATABASE_URL: 'postgresql://runtime:runtime@database.test:5432/runtime',
  DATABASE_POOL_MAX: 7,
  DATABASE_CONNECTION_TIMEOUT_MS: 4_000,
  DATABASE_IDLE_TIMEOUT_MS: 20_000,
  DATABASE_QUERY_TIMEOUT_MS: 25_000,
  DATABASE_LOCK_TIMEOUT_MS: 8_000,
  DATABASE_IDLE_TRANSACTION_TIMEOUT_MS: 15_000,
  DATABASE_MAX_LIFETIME_SECONDS: 1_800,
  RUNTIME_INSTANCE_ID: 'desktop:7',
} as RuntimeConfig);

afterEach(() => vi.restoreAllMocks());

describe('DatabaseService', () => {
  it('bounds pool acquisition, SQL execution, locks, idle transactions and connection lifetime', async () => {
    const database = new DatabaseService(databaseConfig());

    expect(database.pool.options).toMatchObject({
      max: 7,
      connectionTimeoutMillis: 4_000,
      idleTimeoutMillis: 20_000,
      query_timeout: 25_000,
      statement_timeout: 25_000,
      lock_timeout: 8_000,
      idle_in_transaction_session_timeout: 15_000,
      maxLifetimeSeconds: 1_800,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      application_name: 'wa-runtime:desktop:7',
    });

    await database.onApplicationShutdown();
  });

  it('handles idle-client errors instead of leaving an unhandled EventEmitter error', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const database = new DatabaseService(databaseConfig());

    expect(() => database.pool.emit('error', new Error('idle connection failed'))).not.toThrow();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'runtime.database.idle_client_error',
      error: expect.any(Error),
    }));

    await database.onApplicationShutdown();
  });

  it('preserves the transaction error and destroys a client whose rollback fails', async () => {
    const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const database = new DatabaseService(databaseConfig());
    const operationFailure = new Error('operation failed');
    const rollbackFailure = new Error('connection lost during rollback');
    const release = vi.fn();
    const query = vi.fn(async (statement: string) => {
      if (statement === 'ROLLBACK') throw rollbackFailure;
      return {};
    });
    Object.defineProperty(database.pool, 'connect', {
      value: vi.fn(async () => ({ query, release } as unknown as PoolClient)),
    });

    await expect(database.transaction(async () => { throw operationFailure; }))
      .rejects.toBe(operationFailure);
    expect(query.mock.calls.map(call => call[0])).toEqual(['BEGIN', 'ROLLBACK']);
    expect(release).toHaveBeenCalledWith(rollbackFailure);
    expect(logError).toHaveBeenCalledWith({
      event: 'runtime.database.transaction_rollback_failed',
      error: rollbackFailure,
    });

    await database.onApplicationShutdown();
  });
});
