import { Inject, Injectable } from '@nestjs/common';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { DatabaseService } from '../../core/database/database.service';
import { readRuntimeWebhookSpoolSnapshot } from '../../core/database/runtime-webhook-spool';

export interface RuntimeReleaseEvidenceSnapshot {
  schemaVersion: 1;
  status: 'complete';
  generatedAt: string;
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

@Injectable()
export class RuntimeReleaseEvidenceService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async snapshot(now = new Date()): Promise<RuntimeReleaseEvidenceSnapshot> {
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
      schemaVersion: 1,
      status: 'complete',
      generatedAt: now.toISOString(),
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
}
