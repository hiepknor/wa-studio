import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../../src/core/config/runtime-config';
import type { DatabaseService } from '../../src/core/database/database.service';
import { RuntimeReleaseEvidenceService } from '../../src/modules/health/runtime-release-evidence.service';

const config = {
  RUNTIME_HTTP_BODY_MAX_BYTES: 1_024,
  RUNTIME_WEBHOOK_SPOOL_MAX_EVENTS: 100,
  RUNTIME_WEBHOOK_SPOOL_MAX_BYTES: 10_000,
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

describe('RuntimeReleaseEvidenceService', () => {
  it('returns a bounded aggregate snapshot without business identifiers', async () => {
    const service = new RuntimeReleaseEvidenceService(
      database() as unknown as DatabaseService,
      config,
    );

    await expect(service.snapshot(new Date('2026-09-04T00:00:00.000Z'))).resolves.toEqual({
      schemaVersion: 1,
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
    });
  });

  it('preserves unresolved counts and ages so the release gate can fail closed', async () => {
    const service = new RuntimeReleaseEvidenceService(
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
});
