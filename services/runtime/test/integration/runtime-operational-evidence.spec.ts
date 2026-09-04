import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { runtimeConfig, type RuntimeConfig } from '../../src/core/config/runtime-config';
import type { DatabaseService } from '../../src/core/database/database.service';
import { RuntimeOperationalEvidenceService } from '../../src/core/observability/runtime-operational-evidence.service';
import { integrationPool, resetIntegrationDatabase } from '../support/integration-database';

const now = new Date('2026-09-04T00:00:00.000Z');

describe('Runtime operational evidence', () => {
  let pool: Pool;
  let service: RuntimeOperationalEvidenceService;

  beforeAll(() => {
    pool = integrationPool();
    const config = {
      ...runtimeConfig(),
      ALLOW_LIVE_SENDS: true,
      OPENWA_CONNECTOR_INSTANCE_ID: 'connector-evidence-test',
      OPENWA_RELEASE_TAG: '0.23.3',
      RUNTIME_INSTANCE_ID: 'desktop-1',
      RUNTIME_PROFILE: 'desktop-managed',
      RUNTIME_HTTP_BODY_MAX_BYTES: 1_048_576,
      RUNTIME_WEBHOOK_SPOOL_MAX_BYTES: 10_485_760,
      RUNTIME_WEBHOOK_SPOOL_MAX_EVENTS: 10_000,
      WA_STUDIO_VERSION: '0.2.2',
    } satisfies RuntimeConfig;
    const database = { query: pool.query.bind(pool) } as unknown as DatabaseService;
    service = new RuntimeOperationalEvidenceService(database, config);
  });

  beforeEach(async () => { await resetIntegrationDatabase(pool); });
  afterAll(async () => { await pool.end(); });

  it('persists only aggregate evidence under the stable managed identity', async () => {
    await expect(service.recordObservation(now)).resolves.toMatchObject({ clean: true });

    const result = await pool.query<{
      managed_instance_id: string;
      gate_clean: boolean;
      violation_codes: string[];
      evidence: Record<string, unknown>;
    }>(
      `SELECT managed_instance_id, gate_clean, violation_codes, evidence
       FROM runtime_operational_observations`,
    );
    expect(result.rows).toEqual([expect.objectContaining({
      managed_instance_id: 'connector-evidence-test',
      gate_clean: true,
      violation_codes: [],
    })]);
    const encoded = JSON.stringify(result.rows[0]?.evidence);
    expect(encoded).not.toContain('sessionId');
    expect(encoded).not.toContain('groupId');
    expect(encoded).not.toContain('apiKey');
  });

  it('proves a continuous clean 24-hour window for one exact candidate', async () => {
    await seedObservationSeries(pool);

    await expect(service.snapshot(now)).resolves.toMatchObject({
      observation: {
        observedWindowSeconds: 86_400,
        sampleCount: 1_441,
        maximumGapSeconds: 60,
        violatingSamples: 0,
        coverageComplete: true,
        candidateIdentity: { managedInstanceId: 'connector-evidence-test' },
      },
    });
  });

  it('fails continuity when a gap or an unsafe sample exists', async () => {
    await seedObservationSeries(pool);
    await pool.query(
      `DELETE FROM runtime_operational_observations
       WHERE observed_at > $1::timestamptz - interval '12 hours 10 minutes'
         AND observed_at < $1::timestamptz - interval '12 hours'`,
      [now],
    );
    await pool.query(
      `UPDATE runtime_operational_observations
       SET gate_clean = false, violation_codes = ARRAY['UNKNOWN_MESSAGE_JOB']
       WHERE observed_at = $1::timestamptz - interval '6 hours'`,
      [now],
    );

    await expect(service.snapshot(now)).resolves.toMatchObject({
      observation: {
        maximumGapSeconds: 600,
        violatingSamples: 1,
        coverageComplete: false,
      },
    });
  });
});

async function seedObservationSeries(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO runtime_operational_observations (
       observed_at, runtime_version, runtime_profile, managed_instance_id, studio_version,
       openwa_release_tag, live_sends_enabled, gate_clean, violation_codes, evidence
     )
     SELECT observed_at, '0.1.0', 'desktop-managed', 'connector-evidence-test', '0.2.2',
       '0.23.3', true, true, ARRAY[]::text[], '{}'::jsonb
     FROM generate_series(
       $1::timestamptz - interval '24 hours',
       $1::timestamptz,
       interval '1 minute'
     ) AS observed_at`,
    [now],
  );
}
