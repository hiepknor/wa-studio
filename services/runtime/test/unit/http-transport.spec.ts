import type { NestExpressApplication } from '@nestjs/platform-express';
import { describe, expect, it, vi } from 'vitest';
import { configureHttpTransport } from '../../src/core/http/configure-http-transport';

describe('HTTP transport policy', () => {
  it('applies one bounded parser, security headers and explicit server limits', () => {
    const disable = vi.fn();
    const use = vi.fn();
    const useBodyParser = vi.fn();
    const server: Record<string, unknown> = {};
    const app = {
      getHttpAdapter: () => ({ getInstance: () => ({ disable }) }),
      use,
      useBodyParser,
      getHttpServer: () => server,
    } as unknown as NestExpressApplication;

    configureHttpTransport(app, {
      maximumJsonBodyBytes: 1_048_576,
      requestTimeoutMs: 30_000,
      headersTimeoutMs: 10_000,
    });

    expect(disable).toHaveBeenCalledWith('x-powered-by');
    expect(useBodyParser).toHaveBeenCalledWith('json', { limit: 1_048_576, strict: true });
    expect(server).toMatchObject({
      requestTimeout: 30_000,
      headersTimeout: 10_000,
      keepAliveTimeout: 5_000,
      maxRequestsPerSocket: 1_000,
    });

    const setHeader = vi.fn();
    const next = vi.fn();
    const middleware = use.mock.calls[0]?.[0] as Function;
    middleware({}, { setHeader }, next);
    expect(setHeader).toHaveBeenCalledWith('cache-control', 'no-store');
    expect(setHeader).toHaveBeenCalledWith('x-content-type-options', 'nosniff');
    expect(setHeader).toHaveBeenCalledWith('x-frame-options', 'DENY');
    expect(next).toHaveBeenCalledOnce();
  });
});
