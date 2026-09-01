import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ApiAppModule } from '../app/api-app.module';
import { runtimeConfig } from '../core/config/runtime-config';
import { configureApi } from '../core/http/configure-api';
import { JsonLogger } from '../core/observability/json-logger';
import { runWithStartupRollback } from '../core/process/run-with-cleanup';

export async function runApi(): Promise<void> {
  const config = runtimeConfig();
  const app = await NestFactory.create<NestExpressApplication>(ApiAppModule, {
    rawBody: true,
    bodyParser: false,
    logger: new JsonLogger('api'),
  });
  configureApi(app);
  app.enableShutdownHooks();
  await runWithStartupRollback(
    () => app.listen(config.PORT, config.RUNTIME_BIND_HOST),
    () => app.close(),
  );
}

if (require.main === module) {
  runApi().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
