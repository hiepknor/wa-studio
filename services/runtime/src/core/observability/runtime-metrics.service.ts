import { Inject, Injectable } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from '@prometheus-io/client';
import { runtimeConfig, type RuntimeConfig } from '../config/runtime-config';
import { RUNTIME_CONFIG } from '../config/runtime-config.module';
import { DatabaseService } from '../database/database.service';
import { readRuntimeWebhookSpoolSnapshot } from '../database/runtime-webhook-spool';
import { readRuntimeStoragePolicySnapshot } from '../database/runtime-storage-policy';
import { QueueService } from '../queue/queue.service';
import { RUNTIME_VERSION } from '../release/runtime-release';

const HTTP_METHODS = new Set([
  'CONNECT', 'DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'TRACE',
]);

export interface RuntimeHttpRequestMetric {
  finish(input: {
    durationMs: number;
    outcome: 'finished' | 'closed';
    route: string;
    statusCode: number;
  }): void;
}

export const runtimeHttpMethod = (method: string): string => {
  const normalized = method.toUpperCase();
  return HTTP_METHODS.has(normalized) ? normalized : 'OTHER';
};

const runtimeHttpStatus = (statusCode: number): string =>
  Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
    ? String(statusCode)
    : 'unknown';

@Injectable()
export class RuntimeMetricsService {
  private readonly registry = new Registry();
  private readonly activeRequests: Gauge<'method'>;
  private readonly requestCount: Counter<'method' | 'outcome' | 'route' | 'status_code'>;
  private readonly requestDuration: Histogram<'method' | 'route'>;
  private readonly dependencyUp: Gauge<'dependency'>;
  private readonly backgroundProcessUp: Gauge<'process'>;
  private readonly databasePoolConnections: Gauge<'state'>;
  private readonly databasePoolWaitingRequests: Gauge;
  private readonly snapshotFailures: Counter<'dependency'>;
  private readonly scrapeDuration: Histogram<'result'>;
  private readonly openWASafetyScopes: Gauge<'circuit_state' | 'rate_mode'>;
  private readonly openWASafetyLeases: Gauge<'lane'>;
  private readonly openWADeferredJobs: Gauge;
  private readonly openWAUnknownJobs: Gauge;
  private readonly openWAOldestUnknownJobAge: Gauge;
  private readonly webhookSpoolEvents: Gauge<'state'>;
  private readonly webhookSpoolBytes: Gauge;
  private readonly webhookSpoolLimitEvents: Gauge;
  private readonly webhookSpoolLimitBytes: Gauge;
  private readonly webhookSpoolOldestActiveAge: Gauge;
  private readonly webhookSpoolOldestDeadAge: Gauge;
  private readonly webhookSpoolAdmissionAvailable: Gauge;
  private readonly storagePolicyState: Gauge<'phase' | 'version'>;
  private readonly storagePolicyRowsRemoved: Gauge<'data_class'>;
  private activeScrape: Promise<string> | undefined;

  constructor(
    private readonly database: DatabaseService,
    private readonly queues: QueueService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {
    collectDefaultMetrics({ register: this.registry, prefix: 'wa_runtime_' });

    const buildInfo = new Gauge({
      name: 'wa_runtime_build_info',
      help: 'Static WA Runtime build and deployment profile information.',
      labelNames: ['queue_backend', 'runtime_profile', 'version'] as const,
      registers: [this.registry],
    });
    buildInfo.set({
      queue_backend: config.QUEUE_BACKEND,
      runtime_profile: config.RUNTIME_PROFILE,
      version: RUNTIME_VERSION,
    }, 1);

    this.activeRequests = new Gauge({
      name: 'wa_runtime_http_requests_active',
      help: 'HTTP requests currently executing in this Runtime API process.',
      labelNames: ['method'] as const,
      registers: [this.registry],
    });
    this.requestCount = new Counter({
      name: 'wa_runtime_http_requests_total',
      help: 'Completed Runtime API HTTP requests.',
      labelNames: ['method', 'outcome', 'route', 'status_code'] as const,
      registers: [this.registry],
    });
    this.requestDuration = new Histogram({
      name: 'wa_runtime_http_request_duration_seconds',
      help: 'Runtime API HTTP request duration in seconds.',
      labelNames: ['method', 'route'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [this.registry],
    });
    this.dependencyUp = new Gauge({
      name: 'wa_runtime_dependency_up',
      help: 'Whether a required Runtime dependency answered its scrape-time probe.',
      labelNames: ['dependency'] as const,
      registers: [this.registry],
    });
    this.backgroundProcessUp = new Gauge({
      name: 'wa_runtime_background_process_up',
      help: 'Whether the current Runtime instance has a fresh background-process heartbeat.',
      labelNames: ['process'] as const,
      registers: [this.registry],
    });
    this.databasePoolConnections = new Gauge({
      name: 'wa_runtime_database_pool_connections',
      help: 'Current PostgreSQL pool connections by bounded state.',
      labelNames: ['state'] as const,
      registers: [this.registry],
    });
    this.databasePoolWaitingRequests = new Gauge({
      name: 'wa_runtime_database_pool_waiting_requests',
      help: 'Requests currently waiting to acquire a PostgreSQL pool connection.',
      registers: [this.registry],
    });
    this.snapshotFailures = new Counter({
      name: 'wa_runtime_metrics_snapshot_failures_total',
      help: 'Operational metric snapshot probes that failed.',
      labelNames: ['dependency'] as const,
      registers: [this.registry],
    });
    this.scrapeDuration = new Histogram({
      name: 'wa_runtime_metrics_scrape_duration_seconds',
      help: 'Time spent refreshing and rendering Runtime metrics.',
      labelNames: ['result'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });
    this.openWASafetyScopes = new Gauge({
      name: 'wa_runtime_openwa_safety_scopes',
      help: 'Durable OpenWA safety scopes by circuit and adaptive-rate state.',
      labelNames: ['circuit_state', 'rate_mode'] as const,
      registers: [this.registry],
    });
    this.openWASafetyLeases = new Gauge({
      name: 'wa_runtime_openwa_safety_leases',
      help: 'Unexpired OpenWA safety leases by bounded lane.',
      labelNames: ['lane'] as const,
      registers: [this.registry],
    });
    this.openWADeferredJobs = new Gauge({
      name: 'wa_runtime_openwa_safety_deferred_message_jobs',
      help: 'Message jobs currently deferred by an OpenWA safety fence or budget.',
      registers: [this.registry],
    });
    this.openWAUnknownJobs = new Gauge({
      name: 'wa_runtime_openwa_unknown_message_jobs',
      help: 'Message jobs with an ambiguous post-dispatch outcome.',
      registers: [this.registry],
    });
    this.openWAOldestUnknownJobAge = new Gauge({
      name: 'wa_runtime_openwa_oldest_unknown_message_job_age_seconds',
      help: 'Age of the oldest unresolved ambiguous outbound Message Job.',
      registers: [this.registry],
    });
    this.webhookSpoolEvents = new Gauge({
      name: 'wa_runtime_webhook_spool_events',
      help: 'Current raw Runtime webhook spool events by bounded state.',
      labelNames: ['state'] as const,
      registers: [this.registry],
    });
    this.webhookSpoolBytes = new Gauge({
      name: 'wa_runtime_webhook_spool_storage_bytes',
      help: 'Bytes charged to the raw Runtime webhook spool ledger.',
      registers: [this.registry],
    });
    this.webhookSpoolLimitEvents = new Gauge({
      name: 'wa_runtime_webhook_spool_limit_events',
      help: 'Configured maximum raw Runtime webhook spool events.',
      registers: [this.registry],
    });
    this.webhookSpoolLimitBytes = new Gauge({
      name: 'wa_runtime_webhook_spool_limit_bytes',
      help: 'Configured maximum raw Runtime webhook spool bytes.',
      registers: [this.registry],
    });
    this.webhookSpoolOldestActiveAge = new Gauge({
      name: 'wa_runtime_webhook_spool_oldest_active_age_seconds',
      help: 'Age of the oldest pending or processing Runtime webhook.',
      registers: [this.registry],
    });
    this.webhookSpoolOldestDeadAge = new Gauge({
      name: 'wa_runtime_webhook_spool_oldest_dead_age_seconds',
      help: 'Age of the oldest unresolved dead Runtime webhook.',
      registers: [this.registry],
    });
    this.webhookSpoolAdmissionAvailable = new Gauge({
      name: 'wa_runtime_webhook_spool_admission_available',
      help: 'Whether Runtime can admit one maximum-sized webhook into its raw spool.',
      registers: [this.registry],
    });
    this.storagePolicyState = new Gauge({
      name: 'wa_runtime_storage_policy_state',
      help: 'Current bounded Runtime storage policy phase.',
      labelNames: ['phase', 'version'] as const,
      registers: [this.registry],
    });
    this.storagePolicyRowsRemoved = new Gauge({
      name: 'wa_runtime_storage_policy_rows_removed',
      help: 'Rows removed or compacted while applying the current storage policy.',
      labelNames: ['data_class'] as const,
      registers: [this.registry],
    });

    this.dependencyUp.set({ dependency: 'postgres' }, 0);
    this.dependencyUp.set({ dependency: 'queue' }, 0);
    this.backgroundProcessUp.set({ process: 'scheduler' }, 0);
    this.backgroundProcessUp.set({ process: 'worker' }, 0);
    this.databasePoolConnections.set({ state: 'idle' }, 0);
    this.databasePoolConnections.set({ state: 'total' }, 0);
    this.databasePoolWaitingRequests.set(0);
    this.openWADeferredJobs.set(0);
    this.openWAUnknownJobs.set(0);
    this.openWAOldestUnknownJobAge.set(0);
    for (const state of ['active', 'dead', 'stored']) {
      this.webhookSpoolEvents.set({ state }, 0);
    }
    this.webhookSpoolBytes.set(0);
    this.webhookSpoolLimitEvents.set(config.RUNTIME_WEBHOOK_SPOOL_MAX_EVENTS);
    this.webhookSpoolLimitBytes.set(config.RUNTIME_WEBHOOK_SPOOL_MAX_BYTES);
    this.webhookSpoolOldestActiveAge.set(0);
    this.webhookSpoolOldestDeadAge.set(0);
    this.webhookSpoolAdmissionAvailable.set(0);
    for (const dataClass of ['inbound_messages', 'runtime_message_events', 'processed_webhooks']) {
      this.storagePolicyRowsRemoved.set({ data_class: dataClass }, 0);
    }
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  startHttpRequest(methodInput: string): RuntimeHttpRequestMetric {
    const method = runtimeHttpMethod(methodInput);
    this.activeRequests.inc({ method });
    let finished = false;
    return {
      finish: input => {
        if (finished) return;
        finished = true;
        this.activeRequests.dec({ method });
        this.requestCount.inc({
          method,
          outcome: input.outcome,
          route: input.route,
          status_code: runtimeHttpStatus(input.statusCode),
        });
        this.requestDuration.observe(
          { method, route: input.route },
          Math.max(0, input.durationMs) / 1_000,
        );
      },
    };
  }

  scrape(): Promise<string> {
    this.activeScrape ??= this.performScrape().finally(() => {
      this.activeScrape = undefined;
    });
    return this.activeScrape;
  }

  private async performScrape(): Promise<string> {
    const started = performance.now();
    this.snapshotDatabasePool();
    const [postgres, queue, openWASafety, webhookSpool, storagePolicy] = await Promise.all([
      this.probePostgres(),
      this.probeQueue(),
      this.snapshotOpenWASafety(),
      this.snapshotWebhookSpool(),
      this.snapshotStoragePolicy(),
    ]);
    const result = postgres && queue && openWASafety && webhookSpool && storagePolicy
      ? 'complete' : 'degraded';
    try {
      return await this.registry.metrics();
    } finally {
      this.scrapeDuration.observe(
        { result },
        Math.max(0, performance.now() - started) / 1_000,
      );
    }
  }

  private snapshotDatabasePool(): void {
    this.databasePoolConnections.set(
      { state: 'total' },
      Math.max(0, this.database.pool.totalCount),
    );
    this.databasePoolConnections.set(
      { state: 'idle' },
      Math.max(0, this.database.pool.idleCount),
    );
    this.databasePoolWaitingRequests.set(Math.max(0, this.database.pool.waitingCount));
  }

  private async probePostgres(): Promise<boolean> {
    try {
      await this.database.query('SELECT 1');
      this.dependencyUp.set({ dependency: 'postgres' }, 1);
      return true;
    } catch {
      this.dependencyUp.set({ dependency: 'postgres' }, 0);
      this.snapshotFailures.inc({ dependency: 'postgres' });
      return false;
    }
  }

  private async probeQueue(): Promise<boolean> {
    try {
      await this.queues.readiness();
      const processes = await this.queues.runtimeProcessHealth();
      this.dependencyUp.set({ dependency: 'queue' }, 1);
      this.backgroundProcessUp.set({ process: 'worker' }, processes.worker === 'healthy' ? 1 : 0);
      this.backgroundProcessUp.set(
        { process: 'scheduler' },
        processes.scheduler === 'healthy' ? 1 : 0,
      );
      return true;
    } catch {
      this.dependencyUp.set({ dependency: 'queue' }, 0);
      this.backgroundProcessUp.set({ process: 'worker' }, 0);
      this.backgroundProcessUp.set({ process: 'scheduler' }, 0);
      this.snapshotFailures.inc({ dependency: 'queue' });
      return false;
    }
  }

  private async snapshotOpenWASafety(): Promise<boolean> {
    try {
      const scopes = await this.database.query<{
        circuit_state: string;
        rate_mode: string;
        count: string;
      }>(
        `SELECT circuit_state::text, rate_mode::text, count(*)::text AS count
         FROM openwa_safety_scopes GROUP BY circuit_state, rate_mode`,
      );
      const leases = await this.database.query<{ lane: string; count: string }>(
        `SELECT lane, count(*)::text AS count FROM openwa_safety_leases
         WHERE lease_expires_at > now() GROUP BY lane`,
      );
      const jobs = await this.database.query<{
        deferred: string;
        unknown: string;
        oldest_unknown_age_seconds: string | null;
      }>(
        `SELECT
           count(*) FILTER (WHERE status = 'SCHEDULED'
             AND last_error LIKE ANY(ARRAY['Safety deferred:%','Safety blocked:%',
               'Final send fence rejected%']))::text AS deferred,
           count(*) FILTER (WHERE status = 'UNKNOWN')::text AS unknown,
           EXTRACT(EPOCH FROM now() - min(updated_at)
             FILTER (WHERE status = 'UNKNOWN'))::text AS oldest_unknown_age_seconds
         FROM message_jobs`,
      );
      this.openWASafetyScopes.reset();
      for (const scope of scopes.rows) {
        this.openWASafetyScopes.set({
          circuit_state: scope.circuit_state,
          rate_mode: scope.rate_mode,
        }, Number(scope.count));
      }
      this.openWASafetyLeases.reset();
      for (const lease of leases.rows) this.openWASafetyLeases.set({ lane: lease.lane }, Number(lease.count));
      this.openWADeferredJobs.set(Number(jobs.rows[0]?.deferred ?? 0));
      this.openWAUnknownJobs.set(Number(jobs.rows[0]?.unknown ?? 0));
      this.openWAOldestUnknownJobAge.set(
        jobs.rows[0]?.oldest_unknown_age_seconds === null
          ? 0
          : Math.max(0, Number(jobs.rows[0]?.oldest_unknown_age_seconds ?? 0)),
      );
      return true;
    } catch {
      this.snapshotFailures.inc({ dependency: 'openwa_safety' });
      return false;
    }
  }

  private async snapshotWebhookSpool(): Promise<boolean> {
    try {
      const snapshot = await readRuntimeWebhookSpoolSnapshot(this.database, this.config);
      this.webhookSpoolEvents.set({ state: 'stored' }, snapshot.storedEvents);
      this.webhookSpoolEvents.set({ state: 'active' }, snapshot.activeEvents);
      this.webhookSpoolEvents.set({ state: 'dead' }, snapshot.deadEvents);
      this.webhookSpoolBytes.set(snapshot.storedBytes);
      this.webhookSpoolOldestActiveAge.set(snapshot.oldestActiveAgeSeconds ?? 0);
      this.webhookSpoolOldestDeadAge.set(snapshot.oldestDeadAgeSeconds ?? 0);
      this.webhookSpoolAdmissionAvailable.set(snapshot.admissionAvailable ? 1 : 0);
      return true;
    } catch {
      this.webhookSpoolAdmissionAvailable.set(0);
      this.snapshotFailures.inc({ dependency: 'webhook_spool' });
      return false;
    }
  }

  private async snapshotStoragePolicy(): Promise<boolean> {
    try {
      const snapshot = await readRuntimeStoragePolicySnapshot(this.database, this.config);
      this.storagePolicyState.reset();
      this.storagePolicyState.set({
        phase: snapshot.phase.toLowerCase(),
        version: String(snapshot.version),
      }, 1);
      this.storagePolicyRowsRemoved.set(
        { data_class: 'inbound_messages' },
        snapshot.inboundMessagesDeleted,
      );
      this.storagePolicyRowsRemoved.set(
        { data_class: 'runtime_message_events' },
        snapshot.runtimeMessageEventsDeleted,
      );
      this.storagePolicyRowsRemoved.set(
        { data_class: 'processed_webhooks' },
        snapshot.processedWebhooksCompacted,
      );
      return true;
    } catch {
      this.storagePolicyState.reset();
      this.snapshotFailures.inc({ dependency: 'storage_policy' });
      return false;
    }
  }
}
