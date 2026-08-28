import { describe, expect, it } from 'vitest';
import { parseRuntimeConfig } from '../../src/core/config/runtime-config';

const validEnvironment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://runtime:runtime@postgres.test:5432/runtime',
  REDIS_URL: 'redis://redis.test:6379',
  RUNTIME_API_KEY: 'runtime-key-with-at-least-32-characters',
  OPENWA_BASE_URL: 'http://openwa.test:2785',
  OPENWA_API_KEY: 'openwa-key',
  OPENWA_WEBHOOK_SECRET: 'webhook-secret-with-at-least-32-characters',
  OPENWA_ALLOWED_SESSION_IDS: '00000000-0000-4000-8000-000000000001',
});

describe('runtime worker concurrency configuration', () => {
  it('preserves the established per-queue defaults', () => {
    const config = parseRuntimeConfig(validEnvironment());

    expect(config).toMatchObject({
      MESSAGE_WORKER_CONCURRENCY: 1,
      WEBHOOK_WORKER_CONCURRENCY: 10,
      GATEWAY_WORKER_CONCURRENCY: 1,
      CAMPAIGN_WORKER_CONCURRENCY: 2,
      RUNTIME_ACTIVITY_RETENTION_DAYS: 90,
      RUNTIME_EVENT_RETENTION_DAYS: 30,
      RUNTIME_INBOX_RETENTION_DAYS: 30,
      RUNTIME_COMPACT_EVENT_PAYLOAD_ENABLED: false,
      RUNTIME_COMPACT_PROCESSED_WEBHOOK_PAYLOAD_ENABLED: false,
      CAMPAIGN_LIVE_PREFLIGHT_TTL_SECONDS: 120,
      CAMPAIGN_MEDIA_IMAGE_MAX_BYTES: 8_388_608,
      CAMPAIGN_MEDIA_STORAGE_MAX_BYTES: 536_870_912,
      CAMPAIGN_MEDIA_UPLOAD_TTL_SECONDS: 86_400,
      CAMPAIGN_MEDIA_ORPHAN_RETENTION_HOURS: 24,
      CAMPAIGN_MEDIA_SEND_MEMORY_BUDGET_BYTES: 33_554_432,
      MESSAGE_SAFE_RETRY_MAX_ATTEMPTS: 5,
      DATABASE_POOL_MAX: 10,
      DATABASE_CONNECTION_TIMEOUT_MS: 5_000,
      DATABASE_IDLE_TIMEOUT_MS: 30_000,
      DATABASE_QUERY_TIMEOUT_MS: 30_000,
      DATABASE_LOCK_TIMEOUT_MS: 10_000,
      DATABASE_IDLE_TRANSACTION_TIMEOUT_MS: 30_000,
      DATABASE_MAX_LIFETIME_SECONDS: 3_600,
      OPENWA_REQUEST_TIMEOUT_MS: 30_000,
      OPENWA_REQUEST_DEADLINE_MS: 120_000,
      OPENWA_RESPONSE_MAX_BYTES: 33_554_432,
      EVENT_INBOX_REQUEST_TIMEOUT_MS: 30_000,
      EVENT_INBOX_RESPONSE_MAX_BYTES: 41_943_040,
      RUNTIME_HTTP_BODY_MAX_BYTES: 1_048_576,
      RUNTIME_HTTP_REQUEST_TIMEOUT_MS: 30_000,
      RUNTIME_HTTP_HEADERS_TIMEOUT_MS: 10_000,
    });
  });

  it('requires an origin-only OpenWA endpoint and a deadline covering each attempt', () => {
    expect(() => parseRuntimeConfig({
      ...validEnvironment(),
      OPENWA_BASE_URL: 'http://openwa.test:2785/api',
    })).toThrow('must be an origin');
    expect(() => parseRuntimeConfig({
      ...validEnvironment(),
      OPENWA_BASE_URL: 'http://operator:secret@openwa.test:2785',
    })).toThrow('must be an origin');
    expect(() => parseRuntimeConfig({
      ...validEnvironment(),
      OPENWA_REQUEST_TIMEOUT_MS: '30000',
      OPENWA_REQUEST_DEADLINE_MS: '29999',
    })).toThrow('must be greater than or equal');
  });

  it('bounds HTTP parsing and requires the header deadline to fit inside the request deadline', () => {
    expect(() => parseRuntimeConfig({
      ...validEnvironment(),
      RUNTIME_HTTP_BODY_MAX_BYTES: '65535',
    })).toThrow();
    expect(() => parseRuntimeConfig({
      ...validEnvironment(),
      RUNTIME_HTTP_REQUEST_TIMEOUT_MS: '5000',
      RUNTIME_HTTP_HEADERS_TIMEOUT_MS: '5001',
    })).toThrow('cannot exceed');
  });

  it.each([
    ['DATABASE_POOL_MAX', '0'],
    ['DATABASE_CONNECTION_TIMEOUT_MS', '99'],
    ['DATABASE_IDLE_TIMEOUT_MS', '999'],
    ['DATABASE_QUERY_TIMEOUT_MS', '300001'],
    ['DATABASE_LOCK_TIMEOUT_MS', '0'],
    ['DATABASE_IDLE_TRANSACTION_TIMEOUT_MS', '999'],
    ['DATABASE_MAX_LIFETIME_SECONDS', '59'],
  ])('rejects unbounded database setting %s=%s', (name, value) => {
    expect(() => parseRuntimeConfig({ ...validEnvironment(), [name]: value })).toThrow();
  });

  it('allows inbox history to be shorter without silently changing existing deployments', () => {
    expect(parseRuntimeConfig({
      ...validEnvironment(),
      RUNTIME_EVENT_RETENTION_DAYS: '60',
    }).RUNTIME_INBOX_RETENTION_DAYS).toBe(60);
    expect(parseRuntimeConfig({
      ...validEnvironment(),
      RUNTIME_EVENT_RETENTION_DAYS: '60',
      RUNTIME_INBOX_RETENTION_DAYS: '7',
    }).RUNTIME_INBOX_RETENTION_DAYS).toBe(7);
  });

  it.each([
    ['MESSAGE_WORKER_CONCURRENCY', '0'],
    ['WEBHOOK_WORKER_CONCURRENCY', '101'],
    ['GATEWAY_WORKER_CONCURRENCY', '1.5'],
    ['CAMPAIGN_WORKER_CONCURRENCY', 'not-a-number'],
  ])('rejects invalid %s values', (name, value) => {
    expect(() => parseRuntimeConfig({ ...validEnvironment(), [name]: value })).toThrow();
  });

  it('keeps the image send memory budget large enough for one maximum-size V1 image', () => {
    expect(() => parseRuntimeConfig({
      ...validEnvironment(),
      CAMPAIGN_MEDIA_SEND_MEMORY_BUDGET_BYTES: '33554431',
    })).toThrow();
  });
});

describe('runtime deployment profile', () => {
  it('bounds the shared Runtime credential accepted from configuration', () => {
    expect(() => parseRuntimeConfig({
      ...validEnvironment(),
      RUNTIME_API_KEY: 'x'.repeat(4097),
    })).toThrow();
  });

  it('preserves the public server bind default for existing deployments', () => {
    const config = parseRuntimeConfig(validEnvironment());

    expect(config.RUNTIME_PROFILE).toBe('server');
    expect(config.RUNTIME_INSTANCE_ID).toBe('default');
    expect(config.RUNTIME_BIND_HOST).toBe('0.0.0.0');
  });

  it('accepts a bounded supervisor generation as the Runtime instance ID', () => {
    expect(parseRuntimeConfig({
      ...validEnvironment(),
      RUNTIME_INSTANCE_ID: 'desktop:7-8f33c6c2',
    }).RUNTIME_INSTANCE_ID).toBe('desktop:7-8f33c6c2');
  });

  it.each(['', 'contains spaces', 'contains/slash'])('rejects invalid Runtime instance ID %j', instanceId => {
    expect(() => parseRuntimeConfig({
      ...validEnvironment(),
      RUNTIME_INSTANCE_ID: instanceId,
    })).toThrow();
  });

  it('binds the managed desktop profile to IPv4 loopback by default', () => {
    const config = parseRuntimeConfig({
      ...validEnvironment(),
      RUNTIME_PROFILE: 'desktop-managed',
    });

    expect(config.RUNTIME_BIND_HOST).toBe('127.0.0.1');
  });

  it('allows an explicit loopback address for managed desktop', () => {
    const config = parseRuntimeConfig({
      ...validEnvironment(),
      RUNTIME_PROFILE: 'desktop-managed',
      RUNTIME_BIND_HOST: '::1',
    });

    expect(config.RUNTIME_BIND_HOST).toBe('::1');
  });

  it.each(['0.0.0.0', '192.0.2.10'])('rejects non-loopback desktop bind host %s', host => {
    expect(() => parseRuntimeConfig({
      ...validEnvironment(),
      RUNTIME_PROFILE: 'desktop-managed',
      RUNTIME_BIND_HOST: host,
    })).toThrow('desktop-managed Runtime must bind to a loopback address');
  });
});

describe('Runtime metrics configuration', () => {
  it('keeps the private metrics endpoint disabled unless a dedicated token is configured', () => {
    expect(parseRuntimeConfig(validEnvironment()).RUNTIME_METRICS_TOKEN).toBeUndefined();
    expect(parseRuntimeConfig({
      ...validEnvironment(),
      RUNTIME_METRICS_TOKEN: 'metrics-token-with-at-least-32-characters',
    }).RUNTIME_METRICS_TOKEN).toBe('metrics-token-with-at-least-32-characters');
  });

  it('rejects short tokens and reuse of the full Runtime API credential', () => {
    expect(() => parseRuntimeConfig({
      ...validEnvironment(),
      RUNTIME_METRICS_TOKEN: 'short',
    })).toThrow();
    expect(() => parseRuntimeConfig({
      ...validEnvironment(),
      RUNTIME_METRICS_TOKEN: validEnvironment().RUNTIME_API_KEY,
    })).toThrow('must be different from RUNTIME_API_KEY');
  });
});

describe('queue backend configuration', () => {
  it('preserves Redis as the server-compatible default', () => {
    expect(parseRuntimeConfig(validEnvironment()).QUEUE_BACKEND).toBe('redis');
  });

  it('allows desktop-managed Runtime to use PostgreSQL without Redis', () => {
    const environment = validEnvironment();
    delete environment.REDIS_URL;

    const config = parseRuntimeConfig({
      ...environment,
      RUNTIME_PROFILE: 'desktop-managed',
      QUEUE_BACKEND: 'postgres',
    });

    expect(config.QUEUE_BACKEND).toBe('postgres');
    expect(config.REDIS_URL).toBeUndefined();
  });

  it('rejects a Redis backend without REDIS_URL', () => {
    const environment = validEnvironment();
    delete environment.REDIS_URL;

    expect(() => parseRuntimeConfig(environment)).toThrow(
      'REDIS_URL is required when QUEUE_BACKEND=redis',
    );
  });
});

describe('Event Inbox configuration', () => {
  it('requires the Event Inbox URL and device token together', () => {
    expect(() => parseRuntimeConfig({
      ...validEnvironment(),
      EVENT_INBOX_BASE_URL: 'https://events.example.test',
    })).toThrow('must be configured together');
  });

  it('requires HTTPS in production and an origin-only URL', () => {
    expect(() => parseRuntimeConfig({
      ...validEnvironment(),
      NODE_ENV: 'production',
      EVENT_INBOX_BASE_URL: 'http://events.example.test',
      EVENT_INBOX_DEVICE_TOKEN: 'device-token-with-at-least-32-characters',
    })).toThrow('must use HTTPS');
    expect(() => parseRuntimeConfig({
      ...validEnvironment(),
      EVENT_INBOX_BASE_URL: 'https://events.example.test/custom/path',
      EVENT_INBOX_DEVICE_TOKEN: 'device-token-with-at-least-32-characters',
    })).toThrow('must be an origin');
  });

  it('allows loopback HTTP only outside production', () => {
    const config = parseRuntimeConfig({
      ...validEnvironment(),
      EVENT_INBOX_BASE_URL: 'http://127.0.0.1:34200',
      EVENT_INBOX_DEVICE_TOKEN: 'device-token-with-at-least-32-characters',
      OPENWA_WEBHOOK_RECONCILIATION_ENABLED: 'true',
      OPENWA_WEBHOOK_CALLBACK_URL: 'http://127.0.0.1:34200/api/v1/webhooks/openwa',
    });
    expect(config.EVENT_INBOX_BATCH_SIZE).toBe(100);
    expect(config.OPENWA_WEBHOOK_RECONCILIATION_ENABLED).toBe(true);

    expect(() => parseRuntimeConfig({
      ...validEnvironment(),
      NODE_ENV: 'production',
      EVENT_INBOX_BASE_URL: 'http://127.0.0.1:34200',
      EVENT_INBOX_DEVICE_TOKEN: 'device-token-with-at-least-32-characters',
      OPENWA_WEBHOOK_RECONCILIATION_ENABLED: 'true',
      OPENWA_WEBHOOK_CALLBACK_URL: 'http://127.0.0.1:34200/api/v1/webhooks/openwa',
    })).toThrow('must use HTTPS');
  });
});
