import 'reflect-metadata';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import IORedis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runtimeHeartbeatKey } from '../../src/core/queue/runtime-heartbeat';

describe('HTTP readiness', () => {
  let app: INestApplication;
  let baseUrl: string;
  let redis: IORedis;

  beforeAll(async () => {
    const { ApiAppModule } = require(resolve(process.cwd(), 'dist/src/app/api-app.module.js')) as {
      ApiAppModule: new (...args: never[]) => unknown;
    };
    app = await NestFactory.create(ApiAppModule, { rawBody: true, logger: false });
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
    redis = new IORedis(process.env.REDIS_URL!);
  });

  beforeEach(async () => {
    await redis.del(
      runtimeHeartbeatKey('default', 'worker'),
      runtimeHeartbeatKey('default', 'scheduler'),
    );
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  it('stays ready while missing background heartbeats are reported as degraded', async () => {
    const response = await fetch(`${baseUrl}/health/ready`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'ready',
      dependencies: { postgres: true, redis: true },
      processes: { worker: 'degraded', scheduler: 'degraded' },
    });
  });

  it('reports fresh background heartbeats as healthy', async () => {
    await redis.set(runtimeHeartbeatKey('default', 'worker'), new Date().toISOString(), 'EX', 60);
    await redis.set(runtimeHeartbeatKey('default', 'scheduler'), new Date().toISOString(), 'EX', 60);

    const response = await fetch(`${baseUrl}/health/ready`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'ready',
      dependencies: { postgres: true, redis: true },
      processes: { worker: 'healthy', scheduler: 'healthy' },
    });
  });

  it('requires current-instance background health for operational status', async () => {
    const headers = { 'X-Runtime-Key': process.env.RUNTIME_API_KEY! };
    const degraded = await fetch(`${baseUrl}/health/operational`, { headers });
    expect(degraded.status).toBe(503);
    await expect(degraded.json()).resolves.toMatchObject({
      status: 'degraded',
      instanceId: 'default',
      reason: 'background_process_degraded',
    });

    await redis.set(runtimeHeartbeatKey('default', 'worker'), new Date().toISOString(), 'EX', 60);
    await redis.set(runtimeHeartbeatKey('default', 'scheduler'), new Date().toISOString(), 'EX', 60);
    const operational = await fetch(`${baseUrl}/health/operational`, { headers });
    expect(operational.status).toBe(200);
    await expect(operational.json()).resolves.toMatchObject({
      status: 'operational',
      service: 'wa-runtime',
      version: '0.1.0',
      instanceId: 'default',
      processes: { worker: 'healthy', scheduler: 'healthy' },
    });
  });
});
