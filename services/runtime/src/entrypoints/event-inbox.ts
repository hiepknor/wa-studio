import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { EventInboxAppModule } from '../app/event-inbox-app.module';
import { eventInboxConfig } from '../core/event-inbox/event-inbox-config';
import { JsonLogger } from '../core/observability/json-logger';

export async function runEventInbox(): Promise<void> {
  const config = eventInboxConfig();
  const app = await NestFactory.create<NestExpressApplication>(EventInboxAppModule, {
    rawBody: true,
    logger: new JsonLogger('event-inbox'),
  });
  app.setGlobalPrefix('api/v1');
  app.useBodyParser('json', { limit: config.EVENT_INBOX_MAX_PAYLOAD_BYTES });
  app.enableShutdownHooks();
  await app.listen(config.EVENT_INBOX_PORT, config.EVENT_INBOX_BIND_HOST);
}

if (require.main === module) {
  runEventInbox().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
