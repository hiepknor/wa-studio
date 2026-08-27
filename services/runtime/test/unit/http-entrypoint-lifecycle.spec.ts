import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  configureApi: vi.fn(),
  configureHttpTransport: vi.fn(),
  create: vi.fn(),
}));

vi.mock('@nestjs/core', () => ({ NestFactory: { create: mocks.create } }));
vi.mock('../../src/app/api-app.module', () => ({ ApiAppModule: class {} }));
vi.mock('../../src/app/event-inbox-app.module', () => ({ EventInboxAppModule: class {} }));
vi.mock('../../src/core/config/runtime-config', () => ({
  runtimeConfig: () => ({ PORT: 8080, RUNTIME_BIND_HOST: '127.0.0.1' }),
}));
vi.mock('../../src/core/event-inbox/event-inbox-config', () => ({
  eventInboxConfig: () => ({
    EVENT_INBOX_BIND_HOST: '127.0.0.1',
    EVENT_INBOX_HTTP_HEADERS_TIMEOUT_MS: 5_000,
    EVENT_INBOX_HTTP_REQUEST_TIMEOUT_MS: 10_000,
    EVENT_INBOX_MAX_PAYLOAD_BYTES: 64_000,
    EVENT_INBOX_PORT: 9090,
  }),
}));
vi.mock('../../src/core/http/configure-api', () => ({ configureApi: mocks.configureApi }));
vi.mock('../../src/core/http/configure-http-transport', () => ({
  configureHttpTransport: mocks.configureHttpTransport,
}));
vi.mock('../../src/core/observability/json-logger', () => ({ JsonLogger: class {} }));

import { runApi } from '../../src/entrypoints/api';
import { runEventInbox } from '../../src/entrypoints/event-inbox';

beforeEach(() => vi.clearAllMocks());

describe('HTTP entrypoint lifecycle', () => {
  it('closes the API context when the listener cannot bind', async () => {
    const startupFailure = new Error('port already in use');
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.create.mockResolvedValue({
      close,
      enableShutdownHooks: vi.fn(),
      listen: vi.fn().mockRejectedValue(startupFailure),
    });

    await expect(runApi()).rejects.toBe(startupFailure);
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not close a successfully listening API context', async () => {
    const close = vi.fn();
    mocks.create.mockResolvedValue({
      close,
      enableShutdownHooks: vi.fn(),
      listen: vi.fn().mockResolvedValue(undefined),
    });

    await expect(runApi()).resolves.toBeUndefined();
    expect(close).not.toHaveBeenCalled();
  });

  it('retains Event Inbox bind and context-close failures together', async () => {
    const startupFailure = new Error('port already in use');
    const closeFailure = new Error('database pool did not close');
    const close = vi.fn().mockRejectedValue(closeFailure);
    mocks.create.mockResolvedValue({
      close,
      enableShutdownHooks: vi.fn(),
      listen: vi.fn().mockRejectedValue(startupFailure),
      set: vi.fn(),
      setGlobalPrefix: vi.fn(),
    });

    const failure = await runEventInbox().catch(error => error) as AggregateError;
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual([startupFailure, closeFailure]);
    expect(close).toHaveBeenCalledOnce();
  });
});
