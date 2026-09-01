import { describe, expect, it } from 'vitest';
import type { EventInboxConnectorStatusResponse } from '../../src/contracts/event-inbox';
import { assessOpenWAConnectorReport } from '../../src/modules/webhooks/openwa-connector-health.repository';

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
  });

  it('does not treat a desired binding without a reporting connector as healthy', () => {
    expect(assess({ ...report(), connector: null })).toMatchObject({
      healthy: false, state: 'AWAITING_PLUGIN', reason: 'connector_not_reporting',
    });
  });
});
