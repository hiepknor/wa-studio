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
  const runtimeHeaders = { 'X-Runtime-Key': process.env.RUNTIME_API_KEY! };

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
    const response = await fetch(`${baseUrl}/health/ready`, { headers: runtimeHeaders });

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

    const response = await fetch(`${baseUrl}/health/ready`, { headers: runtimeHeaders });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'ready',
      dependencies: { postgres: true, redis: true },
      processes: { worker: 'healthy', scheduler: 'healthy' },
    });
  });

  it('requires current-instance background health for operational status', async () => {
    const degraded = await fetch(`${baseUrl}/health/operational`, { headers: runtimeHeaders });
    expect(degraded.status).toBe(503);
    await expect(degraded.json()).resolves.toMatchObject({
      status: 'degraded',
      instanceId: 'default',
      reason: 'background_process_degraded',
    });

    await redis.set(runtimeHeartbeatKey('default', 'worker'), new Date().toISOString(), 'EX', 60);
    await redis.set(runtimeHeartbeatKey('default', 'scheduler'), new Date().toISOString(), 'EX', 60);
    const operational = await fetch(`${baseUrl}/health/operational`, { headers: runtimeHeaders });
    expect(operational.status).toBe(200);
    const payload = await operational.json() as Record<string, any>;
    expect(payload).toMatchObject({
      service: 'wa-runtime',
      version: '0.1.0',
      instanceId: 'default',
      processes: { worker: 'healthy', scheduler: 'healthy' },
      components: { openwa: { expectedRelease: expect.any(String) } },
    });
    expect(['operational', 'degraded']).toContain(payload.status);
    if (payload.status === 'degraded') {
      expect([
        'upstream_status_unknown', 'upstream_unavailable', 'upstream_incompatible',
      ]).toContain(payload.reason);
    }
  });

  it('keeps detailed readiness behind the Runtime API credential', async () => {
    const missing = await fetch(`${baseUrl}/health/ready`);
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Missing or invalid X-Runtime-Key',
    });

    const wrong = await fetch(`${baseUrl}/health/ready`, {
      headers: { 'X-Runtime-Key': `${process.env.RUNTIME_API_KEY!}-wrong` },
    });
    expect(wrong.status).toBe(401);

    const live = await fetch(`${baseUrl}/health/live`);
    expect(live.status).toBe(200);
  });

  it('exposes bounded release evidence only through the authenticated health surface', async () => {
    const missing = await fetch(`${baseUrl}/health/release-evidence`);
    expect(missing.status).toBe(401);

    const response = await fetch(`${baseUrl}/health/release-evidence`, {
      headers: runtimeHeaders,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: 1,
      status: 'complete',
      generatedAt: expect.any(String),
      openwaSafety: {
        unknownMessageJobs: expect.any(Number),
        deferredMessageJobs: expect.any(Number),
      },
      webhookSpool: {
        storedEvents: expect.any(Number),
        deadEvents: expect.any(Number),
        admissionAvailable: expect.any(Boolean),
      },
    });
  });

  it('exposes low-cardinality Prometheus metrics only to the dedicated bearer token', async () => {
    const unauthorized = await fetch(`${baseUrl}/metrics`);
    expect(unauthorized.status).toBe(401);

    const runtimeKey = await fetch(`${baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${process.env.RUNTIME_API_KEY!}` },
    });
    expect(runtimeKey.status).toBe(401);

    const sensitivePath = 'private-value-that-must-not-be-a-metric-label';
    expect((await fetch(`${baseUrl}/${sensitivePath}`)).status).toBe(404);
    await fetch(`${baseUrl}/health/live`);
    const response = await fetch(`${baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${process.env.RUNTIME_METRICS_TOKEN!}` },
    });
    const output = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(output).toContain('wa_runtime_http_requests_total');
    expect(output).toContain('route="/api/v1/health/live"');
    expect(output).toContain('route="<unmatched>"');
    expect(output).not.toContain(sensitivePath);
    expect(output).not.toContain(process.env.RUNTIME_METRICS_TOKEN!);
  });
});
