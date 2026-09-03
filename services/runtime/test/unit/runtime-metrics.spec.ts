import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../../src/core/config/runtime-config';
import type { DatabaseService } from '../../src/core/database/database.service';
import { httpRouteLabel } from '../../src/core/observability/request-context.middleware';
import {
  RuntimeMetricsTokenGuard,
} from '../../src/core/observability/runtime-metrics.controller';
import {
  RuntimeMetricsService,
  runtimeHttpMethod,
} from '../../src/core/observability/runtime-metrics.service';
import type { QueueService } from '../../src/core/queue/queue.service';

const config = (token?: string): RuntimeConfig => ({
  QUEUE_BACKEND: 'redis',
  RUNTIME_METRICS_TOKEN: token,
  RUNTIME_PROFILE: 'server',
  RUNTIME_STORAGE_POLICY_VERSION: '1',
  RUNTIME_MESSAGE_STORAGE_MODE: 'full',
  RUNTIME_COMPACT_PROCESSED_WEBHOOK_PAYLOAD_ENABLED: false,
  RUNTIME_HTTP_BODY_MAX_BYTES: 1_048_576,
  RUNTIME_WEBHOOK_SPOOL_MAX_EVENTS: 100_000,
  RUNTIME_WEBHOOK_SPOOL_MAX_BYTES: 1_073_741_824,
} as RuntimeConfig);

const executionContext = (authorization?: string) => ({
  switchToHttp: () => ({
    getRequest: () => ({
      header: (name: string) => name === 'authorization' ? authorization : undefined,
    }),
  }),
});

describe('Runtime metrics authentication', () => {
  const token = 'metrics-token-with-at-least-32-characters';

  it('hides the endpoint when no dedicated token is configured', () => {
    const guard = new RuntimeMetricsTokenGuard(config());
    expect(() => guard.canActivate(executionContext() as never)).toThrow(NotFoundException);
  });

  it('requires an exact bearer token and rejects alternate authorization forms', () => {
    const guard = new RuntimeMetricsTokenGuard(config(token));
    for (const authorization of [
      undefined,
      token,
      `Basic ${token}`,
      `Bearer ${token}-wrong`,
    ]) {
      expect(() => guard.canActivate(executionContext(authorization) as never))
        .toThrow(UnauthorizedException);
    }
    expect(guard.canActivate(executionContext(`Bearer ${token}`) as never)).toBe(true);
    expect(guard.canActivate(executionContext(`bearer ${token}`) as never)).toBe(true);
  });
});

describe('Runtime metrics cardinality and collection', () => {
  it('bounds arbitrary HTTP methods and never uses unmatched request paths as labels', () => {
    expect(runtimeHttpMethod('get')).toBe('GET');
    expect(runtimeHttpMethod('attacker-controlled-method')).toBe('OTHER');
    expect(httpRouteLabel({ baseUrl: '', route: undefined } as never)).toBe('<unmatched>');
    expect(httpRouteLabel({ baseUrl: '/api/v1', route: { path: '/groups/:id' } } as never))
      .toBe('/api/v1/groups/:id');
  });

  it('exports process, HTTP, dependency and background heartbeat metrics without identifiers', async () => {
    const database = {
      pool: { totalCount: 8, idleCount: 3, waitingCount: 2 },
      query: vi.fn().mockImplementation((sql: string) => Promise.resolve(sql.includes(
        'runtime_webhook_spool_usage',
      ) ? {
          rows: [{
            stored_events: '3', stored_bytes: '4096', dead_events: '1',
            oldest_active_age_seconds: '12.4',
          }],
        } : sql.includes('runtime_storage_policy_state')
          ? { rows: [] }
          : { rows: [{ '?column?': 1 }] })),
    };
    const queues = {
      readiness: vi.fn().mockResolvedValue({ backend: 'redis', ready: true }),
      runtimeProcessHealth: vi.fn().mockResolvedValue({ worker: 'healthy', scheduler: 'degraded' }),
    };
    const metrics = new RuntimeMetricsService(
      database as unknown as DatabaseService,
      queues as unknown as QueueService,
      config('metrics-token-with-at-least-32-characters'),
    );
    const request = metrics.startHttpRequest('GET');
    request.finish({
      durationMs: 125,
      outcome: 'finished',
      route: '/api/v1/groups/:id',
      statusCode: 200,
    });
    request.finish({
      durationMs: 999,
      outcome: 'closed',
      route: '/must-not-be-counted',
      statusCode: 500,
    });

    const output = await metrics.scrape();

    expect(output).toContain('wa_runtime_build_info{queue_backend="redis",runtime_profile="server",version="0.1.0"} 1');
    expect(output).toContain('wa_runtime_process_cpu_user_seconds_total');
    expect(output).toContain('wa_runtime_nodejs_version_info');
    expect(output).toContain('wa_runtime_http_requests_active{method="GET"} 0');
    expect(output).toContain('wa_runtime_http_requests_total{method="GET",outcome="finished",route="/api/v1/groups/:id",status_code="200"} 1');
    expect(output).not.toContain('/must-not-be-counted');
    expect(output).toContain('wa_runtime_dependency_up{dependency="postgres"} 1');
    expect(output).toContain('wa_runtime_dependency_up{dependency="queue"} 1');
    expect(output).toContain('wa_runtime_background_process_up{process="worker"} 1');
    expect(output).toContain('wa_runtime_background_process_up{process="scheduler"} 0');
    expect(output).toContain('wa_runtime_database_pool_connections{state="total"} 8');
    expect(output).toContain('wa_runtime_database_pool_connections{state="idle"} 3');
    expect(output).toContain('wa_runtime_database_pool_waiting_requests 2');
    expect(output).toContain('wa_runtime_webhook_spool_events{state="stored"} 3');
    expect(output).toContain('wa_runtime_webhook_spool_events{state="active"} 2');
    expect(output).toContain('wa_runtime_webhook_spool_events{state="dead"} 1');
    expect(output).toContain('wa_runtime_webhook_spool_storage_bytes 4096');
    expect(output).toContain('wa_runtime_webhook_spool_admission_available 1');
    expect(output).toContain('wa_runtime_storage_policy_state{phase="not_applicable",version="1"} 1');
    expect(output).not.toContain('metrics-token-with-at-least-32-characters');
  });

  it('keeps serving degraded metrics and coalesces concurrent dependency probes', async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const database = {
      pool: { totalCount: 10, idleCount: 0, waitingCount: 4 },
      query: vi.fn().mockImplementation(() => waiting.then(() => ({ rows: [] }))),
    };
    const queues = {
      readiness: vi.fn().mockRejectedValue(new Error('queue unavailable')),
      runtimeProcessHealth: vi.fn(),
    };
    const metrics = new RuntimeMetricsService(
      database as unknown as DatabaseService,
      queues as unknown as QueueService,
      config('metrics-token-with-at-least-32-characters'),
    );

    const first = metrics.scrape();
    const second = metrics.scrape();
    release();
    const [firstOutput, secondOutput] = await Promise.all([first, second]);

    expect(firstOutput).toBe(secondOutput);
    expect(database.query).toHaveBeenCalledTimes(6);
    expect(queues.readiness).toHaveBeenCalledTimes(1);
    expect(queues.runtimeProcessHealth).not.toHaveBeenCalled();
    expect(firstOutput).toContain('wa_runtime_dependency_up{dependency="queue"} 0');
    expect(firstOutput).toContain('wa_runtime_metrics_snapshot_failures_total{dependency="queue"} 1');
  });
});
