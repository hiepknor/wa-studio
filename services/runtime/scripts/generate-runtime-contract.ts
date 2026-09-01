import 'reflect-metadata';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';

function contractOutputPath(): string {
  const outputIndex = process.argv.indexOf('--output');
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  if (!output || output.startsWith('-')) {
    throw new Error('Runtime contract generation requires --output <path>');
  }
  return resolve(process.cwd(), output);
}

async function main(): Promise<void> {
  Object.assign(process.env, {
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://contract:contract@127.0.0.1:5432/contract',
    // OpenAPI generation only inspects application metadata. Keep its queue
    // transport lazy so the contract build never depends on a running Redis.
    QUEUE_BACKEND: 'postgres',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    RUNTIME_API_KEY: process.env.RUNTIME_API_KEY ?? 'contract-runtime-key-000000000000000',
    OPENWA_BASE_URL: process.env.OPENWA_BASE_URL ?? 'http://127.0.0.1:3000',
    OPENWA_API_KEY: process.env.OPENWA_API_KEY ?? 'contract-openwa-key',
    OPENWA_WEBHOOK_SECRET: process.env.OPENWA_WEBHOOK_SECRET ?? 'contract-webhook-secret-0000000000000',
    OPENWA_ALLOWED_SESSION_IDS: process.env.OPENWA_ALLOWED_SESSION_IDS
      ?? '00000000-0000-4000-8000-000000000001',
  });
  const [{ AppModule }, { createOpenApiDocument }] = await Promise.all([
    import('../src/app.module'),
    import('../src/core/openapi'),
  ]);
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api/v1');
  const targetPath = contractOutputPath();
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(
    targetPath,
    `${JSON.stringify(createOpenApiDocument(app), null, 2)}\n`,
    'utf8',
  );
  await app.close();
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
