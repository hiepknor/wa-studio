import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ApiAppModule } from '../app/api-app.module';
import { runtimeConfig } from '../core/config/runtime-config';
import { configureApi } from '../core/http/configure-api';
import { JsonLogger } from '../core/observability/json-logger';

export async function runApi(): Promise<void> {
  const config = runtimeConfig();
  const app = await NestFactory.create(ApiAppModule, { rawBody: true, logger: new JsonLogger('api') });
  configureApi(app);
  app.enableShutdownHooks();
  await app.listen(config.PORT, config.RUNTIME_BIND_HOST);
}

if (require.main === module) {
  runApi().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
