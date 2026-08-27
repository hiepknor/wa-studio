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

    this.dependencyUp.set({ dependency: 'postgres' }, 0);
    this.dependencyUp.set({ dependency: 'queue' }, 0);
    this.backgroundProcessUp.set({ process: 'scheduler' }, 0);
    this.backgroundProcessUp.set({ process: 'worker' }, 0);
    this.databasePoolConnections.set({ state: 'idle' }, 0);
    this.databasePoolConnections.set({ state: 'total' }, 0);
    this.databasePoolWaitingRequests.set(0);
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
    const [postgres, queue] = await Promise.all([
      this.probePostgres(),
      this.probeQueue(),
    ]);
    const result = postgres && queue ? 'complete' : 'degraded';
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
}
