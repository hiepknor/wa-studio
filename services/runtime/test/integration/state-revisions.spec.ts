import 'reflect-metadata';
import { resolve } from 'node:path';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DISALLOWED_SESSION_ID,
  INTEGRATION_GROUP_ID,
  INTEGRATION_SESSION_ID,
  integrationPool,
  resetIntegrationDatabase,
} from '../support/integration-database';

const resources = [
  'sessions',
  'groups',
  'groupLists',
  'campaigns',
  'runs',
  'deliveries',
  'activity',
] as const;

type RevisionVector = { sessionId: string | null } & Record<typeof resources[number], number>;

describe('Runtime resource revision vector', () => {
  let pool: Pool;
  let app: INestApplication;
  let baseUrl: string;
  const headers = { 'x-runtime-key': process.env.RUNTIME_API_KEY! };

  beforeAll(async () => {
    pool = integrationPool();
    const { ApiAppModule } = require(resolve(process.cwd(), 'dist/src/app/api-app.module.js')) as {
      ApiAppModule: new (...args: never[]) => unknown;
    };
    app = await NestFactory.create(ApiAppModule, { rawBody: true, logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  });

  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
    await pool.query(
      `INSERT INTO gateway_sessions
         (id, name, status, engine_loaded, gateway_created_at, gateway_updated_at)
       VALUES ($1, 'Allowed', 'ready', true, now(), now()),
              ($2, 'Disallowed', 'ready', true, now(), now())`,
      [INTEGRATION_SESSION_ID, DISALLOWED_SESSION_ID],
    );
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  async function read(sessionId = INTEGRATION_SESSION_ID) {
    const response = await fetch(
      `${baseUrl}/state-revisions?sessionId=${encodeURIComponent(sessionId)}`,
      { headers },
    );
    return { response, body: await response.json() as RevisionVector };
  }

  it('returns a scoped vector and observes every supported resource bump', async () => {
    const baseline = await read();
    expect(baseline.response.status).toBe(200);
    expect(baseline.body.sessionId).toBe(INTEGRATION_SESSION_ID);

    for (const resource of resources) {
      await pool.query('SELECT bump_runtime_resource_revision($1, $2)', [
        INTEGRATION_SESSION_ID,
        resource,
      ]);
    }

    const updated = await read();
    resources.forEach(resource => {
      expect(updated.body[resource]).toBe(baseline.body[resource] + 1);
    });
  });

  it('bumps the groups resource from canonical table changes', async () => {
    const baseline = await read();
    await pool.query(
      `INSERT INTO gateway_groups (session_id, id, name)
       VALUES ($1, $2, 'Revision group')`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    const updated = await read();
    expect(updated.body.groups).toBe(baseline.body.groups + 1);
  });

  it('does not expose or aggregate a disallowed session', async () => {
    const baseline = await read();
    await pool.query('SELECT bump_runtime_resource_revision($1, $2)', [
      DISALLOWED_SESSION_ID,
      'sessions',
    ]);
    const allowed = await read();
    expect(allowed.body.sessions).toBe(baseline.body.sessions);

    const disallowed = await read(DISALLOWED_SESSION_ID);
    expect(disallowed.response.status).toBe(404);
  });

  it('observes allowlisted session discovery without an active session', async () => {
    const response = await fetch(`${baseUrl}/state-revisions`, { headers });
    const body = await response.json() as RevisionVector;
    expect(response.status).toBe(200);
    expect(body.sessionId).toBeNull();
    expect(body.sessions).toBeGreaterThan(0);
    expect(body.groups).toBe(0);
    expect(body.groupLists).toBe(0);
  });
});
