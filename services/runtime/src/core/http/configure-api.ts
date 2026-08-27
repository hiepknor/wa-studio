import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { runtimeConfig } from '../config/runtime-config';
import { createOpenApiDocument } from '../openapi';
import { configureHttpTransport } from './configure-http-transport';

export function configureApi(app: NestExpressApplication): void {
  const config = runtimeConfig();
  configureHttpTransport(app, {
    maximumJsonBodyBytes: config.RUNTIME_HTTP_BODY_MAX_BYTES,
    requestTimeoutMs: config.RUNTIME_HTTP_REQUEST_TIMEOUT_MS,
    headersTimeoutMs: config.RUNTIME_HTTP_HEADERS_TIMEOUT_MS,
  });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  if (config.enableRuntimeDocs) {
    const document = createOpenApiDocument(app);
    SwaggerModule.setup('api/v1/docs', app, document, { jsonDocumentUrl: 'api/v1/openapi.json' });
  }
}
