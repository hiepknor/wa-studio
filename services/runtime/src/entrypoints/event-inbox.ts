import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { EventInboxAppModule } from '../app/event-inbox-app.module';
import { eventInboxConfig } from '../core/event-inbox/event-inbox-config';
import { configureHttpTransport } from '../core/http/configure-http-transport';
import { JsonLogger } from '../core/observability/json-logger';
import { runWithStartupRollback } from '../core/process/run-with-cleanup';

export async function runEventInbox(): Promise<void> {
  const config = eventInboxConfig();
  const app = await NestFactory.create<NestExpressApplication>(EventInboxAppModule, {
    rawBody: true,
    bodyParser: false,
    logger: new JsonLogger('event-inbox'),
  });
  app.set('trust proxy', 1);
  app.setGlobalPrefix('api/v1');
  configureHttpTransport(app, {
    maximumJsonBodyBytes: config.EVENT_INBOX_MAX_PAYLOAD_BYTES,
    requestTimeoutMs: config.EVENT_INBOX_HTTP_REQUEST_TIMEOUT_MS,
    headersTimeoutMs: config.EVENT_INBOX_HTTP_HEADERS_TIMEOUT_MS,
  });
  app.enableShutdownHooks();
  await runWithStartupRollback(
    () => app.listen(config.EVENT_INBOX_PORT, config.EVENT_INBOX_BIND_HOST),
    () => app.close(),
  );
}

if (require.main === module) {
  runEventInbox().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
