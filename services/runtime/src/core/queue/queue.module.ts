import { Global, Module } from '@nestjs/common';
import type { RuntimeConfig } from '../config/runtime-config';
import { RUNTIME_CONFIG } from '../config/runtime-config.module';
import { DatabaseService } from '../database/database.service';
import { PostgresQueueTransport } from './postgres-queue.transport';
import { RedisQueueTransport } from './redis-queue.transport';
import { QueueService } from './queue.service';
import { QUEUE_TRANSPORT } from './queue-transport';

@Global()
@Module({
  providers: [
    {
      provide: QUEUE_TRANSPORT,
      inject: [RUNTIME_CONFIG, DatabaseService],
      useFactory: (config: RuntimeConfig, database: DatabaseService) =>
        config.QUEUE_BACKEND === 'postgres'
          ? new PostgresQueueTransport(database)
          : new RedisQueueTransport(config),
    },
    QueueService,
  ],
  exports: [QueueService],
})
export class QueueModule {}
