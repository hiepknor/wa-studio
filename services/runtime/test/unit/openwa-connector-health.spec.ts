import { describe, expect, it, vi } from 'vitest';
import type { EventInboxConnectorStatusResponse } from '../../src/contracts/event-inbox';
import { parseRuntimeConfig } from '../../src/core/config/runtime-config';
import type { DatabaseService } from '../../src/core/database/database.service';
import {
  assessOpenWAConnectorReport,
  OpenWAConnectorHealthRepository,
} from '../../src/modules/webhooks/openwa-connector-health.repository';

const sessionId = '00000000-0000-4000-8000-000000000001';
const generatedAt = new Date('2026-08-31T08:00:20.000Z');

type SessionStatus = EventInboxConnectorStatusResponse['sessions'][number];

const report = (overrides: Record<string, unknown> = {}): SessionStatus => ({
  sessionId,
  binding: {
    connectorId: '00000000-0000-4000-8000-000000000002',
    webhookId: 'webhook-1',
    generation: 2,
    updatedAt: '2026-08-31T08:00:00.000Z',
  },
  connector: {
    connectorId: '00000000-0000-4000-8000-000000000002',
    tokenGeneration: 1,
    pluginVersion: '1.0.0',
    protocolVersion: 1,
    journalSchemaVersion: 1,
    bindingGeneration: 2,
    pendingCount: 0,
    oldestPendingSeconds: null,
    storageUtilization: 0.1,
    blockedReason: null,
    observedAt: '2026-08-31T08:00:15.000Z',
    ...overrides,
  },
}) as SessionStatus;

const assess = (candidate: SessionStatus | undefined) => assessOpenWAConnectorReport({
  expectedConnectorId: '00000000-0000-4000-8000-000000000002',
  expectedPluginVersion: '1.0.0',
  connectorId: '00000000-0000-4000-8000-000000000002',
  webhookId: 'webhook-1',
  generation: 2,
  report: candidate,
  generatedAt,
  requestDurationMs: 1_000,
  staleAfterMs: 20_000,
  blockStorageUtilization: 0.75,
});

describe('OpenWA connector health assessment', () => {
  it('issues only the conservative remainder of the heartbeat lease', () => {
    expect(assess(report())).toEqual({
      healthy: true,
      state: 'RECOVERING',
      reason: 'awaiting_healthy_heartbeat_quorum',
      remainingLeaseMs: 14_000,
    });
  });

  it('fails closed for a stale heartbeat, binding drift and storage pressure', () => {
    expect(assess(report({ observedAt: '2026-08-31T07:59:59.000Z' }))).toMatchObject({
      healthy: false, state: 'STALE', reason: 'connector_heartbeat_stale',
    });
    expect(assess(report({ bindingGeneration: 1 }))).toMatchObject({
      healthy: false, state: 'BINDING_MISMATCH',
    });
    expect(assess(report({ connectorId: '00000000-0000-4000-8000-000000000099' })))
      .toMatchObject({
        healthy: false, state: 'BINDING_MISMATCH', reason: 'connector_identity_mismatch',
      });
    expect(assess(report({ storageUtilization: 0.75 }))).toMatchObject({
      healthy: false, state: 'BLOCKED', reason: 'connector_storage_pressure',
    });
    expect(assess(report({ protocolVersion: 2 }))).toMatchObject({
      healthy: false, state: 'BLOCKED', reason: 'connector_protocol_incompatible',
    });
    expect(assess(report({ journalSchemaVersion: 2 }))).toMatchObject({
      healthy: false, state: 'BLOCKED', reason: 'connector_journal_schema_incompatible',
    });
    expect(assess(report({ pluginVersion: '0.9.0' }))).toMatchObject({
      healthy: false, state: 'BLOCKED', reason: 'connector_plugin_version_mismatch',
    });
  });

  it('fails closed when the desired binding is not the provisioned connector', () => {
    expect(assessOpenWAConnectorReport({
      expectedConnectorId: '00000000-0000-4000-8000-000000000099',
      expectedPluginVersion: '1.0.0',
      connectorId: '00000000-0000-4000-8000-000000000002',
      webhookId: 'webhook-1',
      generation: 2,
      report: report(),
      generatedAt,
      requestDurationMs: 1_000,
      staleAfterMs: 20_000,
      blockStorageUtilization: 0.75,
    })).toMatchObject({
      healthy: false,
      state: 'BINDING_MISMATCH',
      reason: 'provisioned_connector_identity_mismatch',
    });
  });

  it('does not treat a desired binding without a reporting connector as healthy', () => {
    expect(assess({ ...report(), connector: null })).toMatchObject({
      healthy: false, state: 'AWAITING_PLUGIN', reason: 'connector_not_reporting',
    });
  });

  it('rechecks the provisioned identity and release at the dispatch lease boundary', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        desired_webhook_id: 'webhook-1',
        desired_connector_id: '00000000-0000-4000-8000-000000000002',
        binding_generation: '2',
      }],
    });
    const config = parseRuntimeConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://runtime:runtime@postgres.test:5432/runtime',
      REDIS_URL: 'redis://redis.test:6379',
      RUNTIME_API_KEY: 'runtime-key-with-at-least-32-characters',
      OPENWA_BASE_URL: 'http://openwa.test:2785',
      OPENWA_API_KEY: 'openwa-key',
      OPENWA_WEBHOOK_SECRET: 'webhook-secret-with-at-least-32-characters',
      OPENWA_ALLOWED_SESSION_IDS: sessionId,
      EVENT_INBOX_BASE_URL: 'http://127.0.0.1:34200',
      EVENT_INBOX_DEVICE_TOKEN: 'device-token-with-at-least-32-characters',
      EVENT_INBOX_CONNECTOR_REQUIRED_FOR_LIVE_SENDS: 'true',
      OPENWA_WEBHOOK_RECONCILIATION_ENABLED: 'true',
      OPENWA_WEBHOOK_CALLBACK_URL: 'http://127.0.0.1:34200/api/v1/webhooks/openwa',
      OPENWA_CONNECTOR_ID: '00000000-0000-4000-8000-000000000002',
      OPENWA_CONNECTOR_PLUGIN_VERSION: '1.0.0',
      OPENWA_CONNECTOR_INSTANCE_ID: 'wa-studio-connector',
      OPENWA_CONNECTOR_INGRESS_SECRET: 'ingress-secret-with-at-least-32-characters',
    });
    const repository = new OpenWAConnectorHealthRepository(
      { query } as unknown as DatabaseService,
      config,
    );

    await expect(repository.requireHealthyBinding(sessionId)).resolves.toMatchObject({
      connectorId: config.OPENWA_CONNECTOR_ID,
      webhookId: 'webhook-1',
      generation: 2,
    });
    expect(query.mock.calls[0]?.[0]).toContain('desired_connector_id = $2::uuid');
    expect(query.mock.calls[0]?.[0]).toContain('plugin_version = $3');
    expect(query.mock.calls[0]?.[1]).toEqual([
      sessionId,
      config.OPENWA_CONNECTOR_ID,
      config.OPENWA_CONNECTOR_PLUGIN_VERSION,
      1,
      1,
    ]);
  });
});
