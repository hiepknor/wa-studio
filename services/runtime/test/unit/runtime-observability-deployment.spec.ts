import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const contract = JSON.parse(readFileSync(
  resolve(process.cwd(), '../../packages/runtime-contract/openapi.json'),
  'utf8',
)) as { paths: Record<string, unknown> };

const deploymentFile = (name: string): string => readFileSync(
  resolve(process.cwd(), 'deploy/observability', name),
  'utf8',
);

describe('Runtime observability deployment contract', () => {
  it('keeps the private scrape endpoint out of the public Runtime API snapshot', () => {
    expect(contract.paths['/api/v1/metrics']).toBeUndefined();
  });

  it('uses a mounted bearer secret and the private Runtime service alias', () => {
    const config = deploymentFile('prometheus.yml');
    expect(config).toContain('metrics_path: /api/v1/metrics');
    expect(config).toContain('credentials_file: /run/secrets/wa_runtime_metrics_token');
    expect(config).toContain('- wa-runtime-api:3100');
    expect(config).toContain('scrape_timeout: 5s');
    expect(config).not.toMatch(/credentials:\s*[^_\n]/u);
    expect(config).not.toContain('RUNTIME_API_KEY');
  });

  it('ships a separate private Event Inbox scrape credential and target', () => {
    const config = deploymentFile('event-inbox-prometheus.yml');
    expect(config).toContain('metrics_path: /api/v1/metrics');
    expect(config).toContain('credentials_file: /run/secrets/wa_event_inbox_metrics_token');
    expect(config).toContain('- event-inbox:34200');
    expect(config).not.toContain('EVENT_INBOX_MASTER_SECRET');
  });

  it('ships availability, dependency, heartbeat, error-rate and latency alerts', () => {
    const rules = deploymentFile('runtime-alerts.yml');
    for (const alert of [
      'WARuntimeScrapeMissing',
      'WARuntimeDependencyUnavailable',
      'WARuntimeBackgroundProcessDegraded',
      'WARuntimeMetricsSnapshotFailures',
      'WARuntimeDatabasePoolSaturated',
      'WARuntimeHighHttpErrorRate',
      'WARuntimeHighHttpLatency',
    ]) {
      expect(rules).toContain(`alert: ${alert}`);
    }
    expect(rules).not.toMatch(/session[_-]?id|group[_-]?id|message[_-]?(?:id|text)/iu);

    const inboxRules = deploymentFile('event-inbox-alerts.yml');
    for (const alert of [
      'WAEventInboxScrapeMissing',
      'WAEventInboxSnapshotUnavailable',
      'WAEventInboxDeadEvents',
      'WAEventInboxPendingAgeHigh',
      'WAEventInboxEventCapacityHigh',
      'WAEventInboxByteCapacityHigh',
      'WAEventInboxPairingRateLimited',
    ]) {
      expect(inboxRules).toContain(`alert: ${alert}`);
    }
  });

  it('validates both Prometheus configurations in CI with a digest-pinned promtool image', () => {
    const workflow = readFileSync(resolve(process.cwd(), '../../.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toContain('prom/prometheus@sha256:');
    expect(workflow).toContain('deploy/observability/prometheus.yml');
    expect(workflow).toContain('deploy/observability/event-inbox-prometheus.yml');
    expect(workflow).not.toContain('prom/prometheus:latest');
  });
});
