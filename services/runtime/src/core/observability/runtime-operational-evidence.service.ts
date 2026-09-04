import { Inject, Injectable } from '@nestjs/common';
import { runtimeConfig, type RuntimeConfig } from '../config/runtime-config';
import { RUNTIME_CONFIG } from '../config/runtime-config.module';
import { DatabaseService } from '../database/database.service';
import { readRuntimeWebhookSpoolSnapshot } from '../database/runtime-webhook-spool';
import { RUNTIME_VERSION } from '../release/runtime-release';

export const RUNTIME_OPERATIONAL_OBSERVATION_INTERVAL_MS = 60_000;
export const RUNTIME_OPERATIONAL_OBSERVATION_REQUIRED_SECONDS = 24 * 60 * 60;
export const RUNTIME_OPERATIONAL_OBSERVATION_MAXIMUM_GAP_SECONDS = 5 * 60;
const RUNTIME_OPERATIONAL_OBSERVATION_RETENTION_DAYS = 7;
const MAXIMUM_ACTIVE_WEBHOOK_AGE_SECONDS = 5 * 60;
const MAXIMUM_WEBHOOK_SPOOL_UTILIZATION = 0.75;

export interface RuntimeInstantaneousReleaseEvidence {
  openwaSafety: {
    openCircuitScopes: number;
    halfOpenCircuitScopes: number;
    manualBlockedScopes: number;
    throttledScopes: number;
    deferredMessageJobs: number;
    unknownMessageJobs: number;
    oldestUnknownMessageJobAgeSeconds: number | null;
  };
  webhookSpool: {
    storedEvents: number;
    storedBytes: number;
    maxStoredEvents: number;
    maxStoredBytes: number;
    maximumIncomingEventBytes: number;
    activeEvents: number;
    deadEvents: number;
    oldestActiveAgeSeconds: number | null;
    oldestDeadAgeSeconds: number | null;
    utilization: number;
    admissionAvailable: boolean;
  };
}

export interface RuntimeOperationalObservationSummary {
  requiredWindowSeconds: number;
  observedWindowSeconds: number;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  sampleCount: number;
  maximumGapSeconds: number | null;
  maximumAllowedGapSeconds: number;
  violatingSamples: number;
  coverageComplete: boolean;
  candidateIdentity: {
    runtimeVersion: string;
    runtimeProfile: RuntimeConfig['RUNTIME_PROFILE'];
    managedInstanceId: string;
    studioVersion: string;
    openwaRelease: string;
  };
}

export interface RuntimeReleaseEvidenceSnapshot extends RuntimeInstantaneousReleaseEvidence {
  schemaVersion: 2;
  status: 'complete';
  generatedAt: string;
  observation: RuntimeOperationalObservationSummary;
}

export interface RuntimeOperationalObservationResult {
  observedAt: string;
  clean: boolean;
  violationCodes: string[];
}

const count = (value: string | undefined, label: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is not a non-negative safe integer`);
  }
  return parsed;
};

const age = (value: string | null | undefined, label: string): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} is invalid`);
  return Math.round(parsed);
};

const elapsedSeconds = (value: string | null | undefined, label: string): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} is invalid`);
  return Math.ceil(parsed);
};

const date = (value: Date | string | null): Date | null => {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.valueOf())) throw new Error('Operational observation timestamp is invalid');
  return parsed;
};

@Injectable()
export class RuntimeOperationalEvidenceService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async snapshot(now = new Date()): Promise<RuntimeReleaseEvidenceSnapshot> {
    const [instantaneous, observation] = await Promise.all([
      this.instantaneousSnapshot(),
      this.observationSummary(now),
    ]);
    return {
      schemaVersion: 2,
      status: 'complete',
      generatedAt: now.toISOString(),
      ...instantaneous,
      observation,
    };
  }

  async recordObservation(now = new Date()): Promise<RuntimeOperationalObservationResult> {
    const evidence = await this.instantaneousSnapshot();
    const violationCodes = this.violationCodes(evidence);
    await this.database.query(
      `INSERT INTO runtime_operational_observations (
         observed_at, runtime_version, runtime_profile, managed_instance_id, studio_version,
         openwa_release_tag, live_sends_enabled, gate_clean, violation_codes, evidence
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10::jsonb)`,
      [
        now,
        RUNTIME_VERSION,
        this.config.RUNTIME_PROFILE,
        this.observationInstanceId(),
        this.config.WA_STUDIO_VERSION,
        this.config.OPENWA_RELEASE_TAG,
        this.config.ALLOW_LIVE_SENDS,
        violationCodes.length === 0,
        violationCodes,
        JSON.stringify(evidence),
      ],
    );
    await this.database.query(
      `DELETE FROM runtime_operational_observations
       WHERE observed_at < $1::timestamptz - ($2::int * interval '1 day')`,
      [now, RUNTIME_OPERATIONAL_OBSERVATION_RETENTION_DAYS],
    );
    return {
      observedAt: now.toISOString(),
      clean: violationCodes.length === 0,
      violationCodes,
    };
  }

  private async instantaneousSnapshot(): Promise<RuntimeInstantaneousReleaseEvidence> {
    const [safety, webhookSpool] = await Promise.all([
      this.database.query<{
        open_circuit_scopes: string;
        half_open_circuit_scopes: string;
        manual_blocked_scopes: string;
        throttled_scopes: string;
        deferred_message_jobs: string;
        unknown_message_jobs: string;
        oldest_unknown_message_job_age_seconds: string | null;
      }>(
        `SELECT
           (SELECT count(*)::text FROM openwa_safety_scopes
            WHERE circuit_state = 'OPEN') AS open_circuit_scopes,
           (SELECT count(*)::text FROM openwa_safety_scopes
            WHERE circuit_state = 'HALF_OPEN') AS half_open_circuit_scopes,
           (SELECT count(*)::text FROM openwa_safety_scopes
            WHERE circuit_state = 'MANUAL_BLOCKED') AS manual_blocked_scopes,
           (SELECT count(*)::text FROM openwa_safety_scopes
            WHERE rate_mode = 'THROTTLED') AS throttled_scopes,
           count(*) FILTER (WHERE status = 'SCHEDULED'
             AND last_error LIKE ANY(ARRAY['Safety deferred:%','Safety blocked:%',
               'Final send fence rejected%']))::text AS deferred_message_jobs,
           count(*) FILTER (WHERE status = 'UNKNOWN')::text AS unknown_message_jobs,
           EXTRACT(EPOCH FROM now() - min(updated_at)
             FILTER (WHERE status = 'UNKNOWN'))::text
             AS oldest_unknown_message_job_age_seconds
         FROM message_jobs`,
      ),
      readRuntimeWebhookSpoolSnapshot(this.database, this.config),
    ]);
    const row = safety.rows[0];
    if (!row) throw new Error('Runtime release safety evidence is unavailable');
    return {
      openwaSafety: {
        openCircuitScopes: count(row.open_circuit_scopes, 'Open circuit scope count'),
        halfOpenCircuitScopes: count(row.half_open_circuit_scopes, 'Half-open circuit scope count'),
        manualBlockedScopes: count(row.manual_blocked_scopes, 'Manual blocked scope count'),
        throttledScopes: count(row.throttled_scopes, 'Throttled scope count'),
        deferredMessageJobs: count(row.deferred_message_jobs, 'Deferred Message Job count'),
        unknownMessageJobs: count(row.unknown_message_jobs, 'Unknown Message Job count'),
        oldestUnknownMessageJobAgeSeconds: age(
          row.oldest_unknown_message_job_age_seconds,
          'Oldest unknown Message Job age',
        ),
      },
      webhookSpool: {
        ...webhookSpool,
        maximumIncomingEventBytes: this.config.RUNTIME_HTTP_BODY_MAX_BYTES,
      },
    };
  }

  private async observationSummary(now: Date): Promise<RuntimeOperationalObservationSummary> {
    const result = await this.database.query<{
      sample_count: string;
      first_observed_at: Date | string | null;
      last_observed_at: Date | string | null;
      maximum_internal_gap_seconds: string | null;
      violating_samples: string;
    }>(
      `WITH scoped AS (
         SELECT observed_at, gate_clean,
           lag(observed_at) OVER (ORDER BY observed_at) AS previous_observed_at
         FROM runtime_operational_observations
         WHERE runtime_version = $1
           AND runtime_profile = $2
           AND managed_instance_id = $3
           AND studio_version = $4
           AND openwa_release_tag = $5
           AND observed_at >= $6::timestamptz
             - (($7::int + $8::int) * interval '1 second')
           AND observed_at <= $6::timestamptz
       )
       SELECT count(*)::text AS sample_count,
         min(observed_at) AS first_observed_at,
         max(observed_at) AS last_observed_at,
         max(EXTRACT(EPOCH FROM observed_at - previous_observed_at))::text
           AS maximum_internal_gap_seconds,
         count(*) FILTER (WHERE NOT gate_clean)::text AS violating_samples
       FROM scoped`,
      [
        RUNTIME_VERSION,
        this.config.RUNTIME_PROFILE,
        this.observationInstanceId(),
        this.config.WA_STUDIO_VERSION,
        this.config.OPENWA_RELEASE_TAG,
        now,
        RUNTIME_OPERATIONAL_OBSERVATION_REQUIRED_SECONDS,
        RUNTIME_OPERATIONAL_OBSERVATION_MAXIMUM_GAP_SECONDS,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Runtime operational observation evidence is unavailable');
    const first = date(row.first_observed_at);
    const last = date(row.last_observed_at);
    const sampleCount = count(row.sample_count, 'Operational observation sample count');
    const violatingSamples = count(row.violating_samples, 'Violating operational observation count');
    const internalGap = elapsedSeconds(
      row.maximum_internal_gap_seconds,
      'Maximum operational observation gap',
    );
    const requiredStart = now.valueOf()
      - RUNTIME_OPERATIONAL_OBSERVATION_REQUIRED_SECONDS * 1_000;
    const endGapSeconds = last === null
      ? null
      : Math.max(0, Math.ceil((now.valueOf() - last.valueOf()) / 1_000));
    const startGapSeconds = first === null
      ? null
      : Math.max(0, Math.ceil((first.valueOf() - requiredStart) / 1_000));
    const maximumGapSeconds = first === null || last === null
      ? null
      : Math.max(internalGap ?? 0, startGapSeconds ?? 0, endGapSeconds ?? 0);
    const observedWindowSeconds = first === null || last === null
      ? 0
      : Math.max(0, Math.floor((last.valueOf() - first.valueOf()) / 1_000));
    const coverageComplete = sampleCount >= 2
      && first !== null
      && first.valueOf() <= requiredStart
      && last !== null
      && last.valueOf() <= now.valueOf()
      && maximumGapSeconds !== null
      && maximumGapSeconds <= RUNTIME_OPERATIONAL_OBSERVATION_MAXIMUM_GAP_SECONDS;
    return {
      requiredWindowSeconds: RUNTIME_OPERATIONAL_OBSERVATION_REQUIRED_SECONDS,
      observedWindowSeconds,
      firstObservedAt: first?.toISOString() ?? null,
      lastObservedAt: last?.toISOString() ?? null,
      sampleCount,
      maximumGapSeconds,
      maximumAllowedGapSeconds: RUNTIME_OPERATIONAL_OBSERVATION_MAXIMUM_GAP_SECONDS,
      violatingSamples,
      coverageComplete,
      candidateIdentity: {
        runtimeVersion: RUNTIME_VERSION,
        runtimeProfile: this.config.RUNTIME_PROFILE,
        managedInstanceId: this.observationInstanceId(),
        studioVersion: this.config.WA_STUDIO_VERSION,
        openwaRelease: this.config.OPENWA_RELEASE_TAG,
      },
    };
  }

  private violationCodes(evidence: RuntimeInstantaneousReleaseEvidence): string[] {
    const violations: string[] = [];
    const safety = evidence.openwaSafety;
    const spool = evidence.webhookSpool;
    if (!this.config.ALLOW_LIVE_SENDS) violations.push('LIVE_SENDS_DISABLED');
    if (safety.openCircuitScopes > 0) violations.push('OPEN_CIRCUIT_SCOPE');
    if (safety.halfOpenCircuitScopes > 0) violations.push('HALF_OPEN_CIRCUIT_SCOPE');
    if (safety.manualBlockedScopes > 0) violations.push('MANUAL_BLOCKED_SCOPE');
    if (safety.throttledScopes > 0) violations.push('THROTTLED_SCOPE');
    if (safety.deferredMessageJobs > 0) violations.push('DEFERRED_MESSAGE_JOB');
    if (safety.unknownMessageJobs > 0) violations.push('UNKNOWN_MESSAGE_JOB');
    if (spool.deadEvents > 0) violations.push('DEAD_WEBHOOK_EVENT');
    if (spool.oldestActiveAgeSeconds !== null
      && spool.oldestActiveAgeSeconds > MAXIMUM_ACTIVE_WEBHOOK_AGE_SECONDS) {
      violations.push('STALLED_WEBHOOK_EVENT');
    }
    if (spool.utilization >= MAXIMUM_WEBHOOK_SPOOL_UTILIZATION) {
      violations.push('WEBHOOK_SPOOL_PRESSURE');
    }
    if (!spool.admissionAvailable) violations.push('WEBHOOK_ADMISSION_UNAVAILABLE');
    return violations;
  }

  private observationInstanceId(): string {
    return this.config.OPENWA_CONNECTOR_INSTANCE_ID ?? this.config.RUNTIME_INSTANCE_ID;
  }
}
