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
      RUNTIME_EVENT_RETENTION_DAYS: 30,
      RUNTIME_INBOX_RETENTION_DAYS: 30,
      RUNTIME_COMPACT_EVENT_PAYLOAD_ENABLED: false,
      RUNTIME_COMPACT_PROCESSED_WEBHOOK_PAYLOAD_ENABLED: false,
    });
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
});

describe('runtime deployment profile', () => {
  it('preserves the public server bind default for existing deployments', () => {
    const config = parseRuntimeConfig(validEnvironment());

    expect(config.RUNTIME_PROFILE).toBe('server');
    expect(config.RUNTIME_BIND_HOST).toBe('0.0.0.0');
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
