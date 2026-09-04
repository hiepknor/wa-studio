import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../../src/core/config/runtime-config';
import type { DatabaseService } from '../../src/core/database/database.service';
import { RuntimeOperationalEvidenceService } from '../../src/core/observability/runtime-operational-evidence.service';

const config = {
  ALLOW_LIVE_SENDS: true,
  OPENWA_CONNECTOR_INSTANCE_ID: 'connector-a',
  OPENWA_RELEASE_TAG: '0.23.3',
  RUNTIME_INSTANCE_ID: 'desktop-a',
  RUNTIME_PROFILE: 'desktop-managed',
  RUNTIME_HTTP_BODY_MAX_BYTES: 1_024,
  RUNTIME_WEBHOOK_SPOOL_MAX_EVENTS: 100,
  RUNTIME_WEBHOOK_SPOOL_MAX_BYTES: 10_000,
  WA_STUDIO_VERSION: '0.2.2',
} as RuntimeConfig;

const database = (unknownMessageJobs = '0') => ({
  query: vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('open_circuit_scopes')) {
      return Promise.resolve({
        rows: [{
          open_circuit_scopes: '0',
          half_open_circuit_scopes: '0',
          manual_blocked_scopes: '0',
          throttled_scopes: '0',
          deferred_message_jobs: '0',
          unknown_message_jobs: unknownMessageJobs,
          oldest_unknown_message_job_age_seconds: unknownMessageJobs === '0' ? null : '12.4',
        }],
      });
    }
    if (sql.includes('FROM runtime_operational_observations')) {
      return Promise.resolve({
        rows: [{
          sample_count: '1441',
          first_observed_at: new Date('2026-09-03T00:00:00.000Z'),
          last_observed_at: new Date('2026-09-04T00:00:00.000Z'),
          maximum_internal_gap_seconds: '60',
          violating_samples: '0',
        }],
      });
    }
    return Promise.resolve({
      rows: [{
        stored_events: '0',
        stored_bytes: '0',
        dead_events: '0',
        oldest_active_age_seconds: null,
        oldest_dead_age_seconds: null,
      }],
    });
  }),
});

describe('RuntimeOperationalEvidenceService', () => {
  it('returns a bounded aggregate snapshot without business identifiers', async () => {
    const service = new RuntimeOperationalEvidenceService(
      database() as unknown as DatabaseService,
      config,
    );

    await expect(service.snapshot(new Date('2026-09-04T00:00:00.000Z'))).resolves.toEqual({
      schemaVersion: 2,
      status: 'complete',
      generatedAt: '2026-09-04T00:00:00.000Z',
      openwaSafety: {
        openCircuitScopes: 0,
        halfOpenCircuitScopes: 0,
        manualBlockedScopes: 0,
        throttledScopes: 0,
        deferredMessageJobs: 0,
        unknownMessageJobs: 0,
        oldestUnknownMessageJobAgeSeconds: null,
      },
      webhookSpool: {
        storedEvents: 0,
        storedBytes: 0,
        maxStoredEvents: 100,
        maxStoredBytes: 10_000,
        maximumIncomingEventBytes: 1_024,
        activeEvents: 0,
        deadEvents: 0,
        oldestActiveAgeSeconds: null,
        oldestDeadAgeSeconds: null,
        utilization: 0,
        admissionAvailable: true,
      },
      observation: {
        requiredWindowSeconds: 86_400,
        observedWindowSeconds: 86_400,
        firstObservedAt: '2026-09-03T00:00:00.000Z',
        lastObservedAt: '2026-09-04T00:00:00.000Z',
        sampleCount: 1441,
        maximumGapSeconds: 60,
        maximumAllowedGapSeconds: 300,
        violatingSamples: 0,
        coverageComplete: true,
        candidateIdentity: {
          runtimeVersion: '0.1.0',
          runtimeProfile: 'desktop-managed',
          managedInstanceId: 'connector-a',
          studioVersion: '0.2.2',
          openwaRelease: '0.23.3',
        },
      },
    });
  });

  it('preserves unresolved counts and ages so the release gate can fail closed', async () => {
    const service = new RuntimeOperationalEvidenceService(
      database('2') as unknown as DatabaseService,
      config,
    );

    await expect(service.snapshot(new Date('2026-09-04T00:00:00.000Z'))).resolves.toMatchObject({
      openwaSafety: {
        unknownMessageJobs: 2,
        oldestUnknownMessageJobAgeSeconds: 12,
      },
    });
  });

  it('records a candidate-bound violation sample and prunes only expired history', async () => {
    const connection = database('2');
    const service = new RuntimeOperationalEvidenceService(
      connection as unknown as DatabaseService,
      config,
    );
    const now = new Date('2026-09-04T00:00:00.000Z');

    await expect(service.recordObservation(now)).resolves.toEqual({
      observedAt: now.toISOString(),
      clean: false,
      violationCodes: ['UNKNOWN_MESSAGE_JOB'],
    });
    const insert = connection.query.mock.calls.find(([sql]) => sql.includes(
      'INSERT INTO runtime_operational_observations',
    ));
    expect(insert?.[1]).toEqual(expect.arrayContaining([
      now,
      '0.1.0',
      'desktop-managed',
      'connector-a',
      '0.2.2',
      '0.23.3',
      true,
      false,
      ['UNKNOWN_MESSAGE_JOB'],
    ]));
    expect(connection.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM runtime_operational_observations'),
      [now, 7],
    );
  });
});
