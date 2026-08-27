import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createApplicationContext: vi.fn(),
}));

vi.mock('@nestjs/core', () => ({
  NestFactory: { createApplicationContext: mocks.createApplicationContext },
}));
vi.mock('../../src/app/worker-app.module', () => ({ WorkerAppModule: class {} }));
vi.mock('../../src/core/observability/json-logger', () => ({ JsonLogger: class {} }));

import { runWorker } from '../../src/entrypoints/worker';

beforeEach(() => vi.clearAllMocks());

describe('worker entrypoint lifecycle', () => {
  it('closes the Nest context when the runner fails', async () => {
    const failure = new Error('worker runner failed');
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.createApplicationContext.mockResolvedValue({
      get: () => ({ run: vi.fn().mockRejectedValue(failure) }),
      close,
    });

    await expect(runWorker()).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
  });

  it('retains runner and context-close failures together', async () => {
    const runnerFailure = new Error('worker runner failed');
    const closeFailure = new Error('context close failed');
    mocks.createApplicationContext.mockResolvedValue({
      get: () => ({ run: vi.fn().mockRejectedValue(runnerFailure) }),
      close: vi.fn().mockRejectedValue(closeFailure),
    });

    const failure = await runWorker().catch(error => error) as AggregateError;
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual([runnerFailure, closeFailure]);
  });
});
