import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ActivityCategory, ActivitySeverity } from '../../src/contracts/activity/activity.dto';
import { appendActivityEvent } from '../../src/core/activity/activity-writer';
import { runtimeConfig } from '../../src/core/config/runtime-config';
import { DatabaseService } from '../../src/core/database/database.service';
import { ActivityRepository } from '../../src/modules/activity/activity.repository';
import { ActivityService } from '../../src/modules/activity/activity.service';
import {
  INTEGRATION_SESSION_ID,
  integrationPool,
  resetIntegrationDatabase,
  seedSendableGroup,
} from '../support/integration-database';

describe('activity ledger', () => {
  let pool: Pool;
  let database: DatabaseService;
  let repository: ActivityRepository;
  let service: ActivityService;

  beforeAll(() => {
    pool = integrationPool();
    database = new DatabaseService();
    repository = new ActivityRepository(database);
    service = new ActivityService(repository, {
      ...runtimeConfig(),
      RUNTIME_ACTIVITY_RETENTION_DAYS: 90,
    });
  });

  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
    await seedSendableGroup(pool);
  });

  afterAll(async () => {
    await database.onApplicationShutdown();
    await pool.end();
  });

  it('commits with domain work, rolls back atomically, and deduplicates retries', async () => {
    const dedupeKey = `session-health:${randomUUID()}`;
    await database.transaction(async (client) => {
      await appendActivityEvent(client, {
        sessionId: INTEGRATION_SESSION_ID,
        eventType: 'session.health_changed',
        category: 'SESSION',
        severity: 'SUCCESS',
        origin: 'GATEWAY',
        subjectType: 'SESSION',
        subjectId: INTEGRATION_SESSION_ID,
        subjectLabelSnapshot: 'Integration session',
        metadata: { status: 'ready' },
        dedupeKey,
      });
      await appendActivityEvent(client, {
        sessionId: INTEGRATION_SESSION_ID,
        eventType: 'session.health_changed',
        category: 'SESSION',
        severity: 'SUCCESS',
        origin: 'GATEWAY',
        subjectType: 'SESSION',
        subjectId: INTEGRATION_SESSION_ID,
        subjectLabelSnapshot: 'Integration session',
        dedupeKey,
      });
    });

    await expect(database.transaction(async (client) => {
      await appendActivityEvent(client, {
        sessionId: INTEGRATION_SESSION_ID,
        eventType: 'sync.failed',
        category: 'SYNC',
        severity: 'ERROR',
        origin: 'RUNTIME',
        subjectType: 'SYNC_RUN',
        subjectId: randomUUID(),
        subjectLabelSnapshot: 'Rolled back sync',
      });
      throw new Error('rollback probe');
    })).rejects.toThrow('rollback probe');

    const rows = await pool.query<{ event_type: string; metadata: Record<string, unknown> }>(
      'SELECT event_type, metadata FROM activity_events ORDER BY created_at, id',
    );
    expect(rows.rows).toEqual([{
      event_type: 'session.health_changed',
      metadata: { status: 'ready' },
    }]);
  });

  it('filters literal search before deterministic cursor pagination', async () => {
    const occurredAt = new Date('2026-08-25T10:00:00.000Z');
    for (const [index, label] of ['Release_% alpha', 'Release_% beta', 'Unrelated'].entries()) {
      await database.transaction(client => appendActivityEvent(client, {
        sessionId: INTEGRATION_SESSION_ID,
        eventType: index === 2 ? 'sync.completed' : 'campaign_run.completed',
        category: index === 2 ? 'SYNC' : 'RUN',
        severity: 'SUCCESS',
        origin: 'RUNTIME',
        subjectType: index === 2 ? 'SYNC_RUN' : 'CAMPAIGN_RUN',
        subjectId: randomUUID(),
        subjectLabelSnapshot: label,
        occurredAt,
      }));
    }

    const first = await service.list({
      sessionId: INTEGRATION_SESSION_ID,
      query: 'Release_%',
      category: [ActivityCategory.RUN],
      severity: [ActivitySeverity.SUCCESS],
      limit: 1,
    });
    expect(first.data).toHaveLength(1);
    expect(first.meta).toMatchObject({ limit: 1, retentionDays: 90 });
    expect(first.meta.nextCursor).toEqual(expect.any(String));

    const second = await service.list({
      sessionId: INTEGRATION_SESSION_ID,
      query: 'Release_%',
      category: [ActivityCategory.RUN],
      severity: [ActivitySeverity.SUCCESS],
      cursor: first.meta.nextCursor!,
      limit: 1,
    });
    expect(second.data).toHaveLength(1);
    expect(second.data[0]!.id).not.toBe(first.data[0]!.id);
    expect(second.meta.nextCursor).toBeNull();
  });

  it('resolves an event by its session-scoped ID and includes event IDs in literal search', async () => {
    const eventId = randomUUID();
    await database.transaction(client => appendActivityEvent(client, {
      sessionId: INTEGRATION_SESSION_ID,
      eventType: 'campaign_run.completed',
      category: 'RUN',
      severity: 'SUCCESS',
      origin: 'RUNTIME',
      subjectType: 'CAMPAIGN_RUN',
      subjectId: randomUUID(),
      subjectLabelSnapshot: 'Release canary',
      dedupeKey: eventId,
    }));
    const stored = await pool.query<{ id: string }>(
      'SELECT id FROM activity_events WHERE dedupe_key = $1',
      [eventId],
    );
    const storedId = stored.rows[0]!.id;

    await expect(service.get(INTEGRATION_SESSION_ID, storedId)).resolves.toMatchObject({
      id: storedId,
      sessionId: INTEGRATION_SESSION_ID,
      eventType: 'campaign_run.completed',
    });
    await expect(service.get(INTEGRATION_SESSION_ID, randomUUID()))
      .rejects.toThrow('Activity event not found');

    const searched = await service.list({
      sessionId: INTEGRATION_SESSION_ID,
      query: storedId,
      limit: 50,
    });
    expect(searched.data.map(item => item.id)).toEqual([storedId]);
  });
});
