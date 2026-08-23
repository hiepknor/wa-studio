import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import { runtimeConfig } from '../config/runtime-config';
import { createOpenApiDocument } from '../openapi';

export function configureApi(app: INestApplication): void {
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  if (runtimeConfig().enableRuntimeDocs) {
    const document = createOpenApiDocument(app);
    SwaggerModule.setup('api/v1/docs', app, document, { jsonDocumentUrl: 'api/v1/openapi.json' });
  }
}
