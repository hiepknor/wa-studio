import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { runtimeConfig, type RuntimeConfig } from '../config/runtime-config';
import { RUNTIME_CONFIG } from '../config/runtime-config.module';
import { runWithCleanup } from '../process/run-with-cleanup';

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  readonly pool: Pool;
  private readonly logger = new Logger(DatabaseService.name);

  constructor(@Inject(RUNTIME_CONFIG) config: RuntimeConfig = runtimeConfig()) {
    this.pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: config.DATABASE_POOL_MAX,
      connectionTimeoutMillis: config.DATABASE_CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: config.DATABASE_IDLE_TIMEOUT_MS,
      query_timeout: config.DATABASE_QUERY_TIMEOUT_MS,
      statement_timeout: config.DATABASE_QUERY_TIMEOUT_MS,
      lock_timeout: config.DATABASE_LOCK_TIMEOUT_MS,
      idle_in_transaction_session_timeout: config.DATABASE_IDLE_TRANSACTION_TIMEOUT_MS,
      maxLifetimeSeconds: config.DATABASE_MAX_LIFETIME_SECONDS,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      application_name: `wa-runtime:${config.RUNTIME_INSTANCE_ID}`.slice(0, 63),
    });
    this.pool.on('error', error => {
      this.logger.error({ event: 'runtime.database.idle_client_error', error });
    });
  }

  query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
    return this.pool.query<T>(text, values);
  }

  async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let releaseError: Error | boolean | undefined;
    return runWithCleanup(
      async () => {
        try {
          await client.query('BEGIN');
          const result = await operation(client);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            releaseError = rollbackError instanceof Error ? rollbackError : true;
            this.logger.error({
              event: 'runtime.database.transaction_rollback_failed',
              error: rollbackError,
            });
          }
          throw error;
        }
      },
      () => client.release(releaseError),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
