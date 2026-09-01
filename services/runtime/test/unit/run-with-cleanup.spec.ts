import { describe, expect, it, vi } from 'vitest';
import {
  runCleanupTasks,
  runWithCleanup,
  runWithStartupRollback,
} from '../../src/core/process/run-with-cleanup';

describe('runWithCleanup', () => {
  it('returns the operation result only after cleanup succeeds', async () => {
    const cleanup = vi.fn();
    await expect(runWithCleanup(async () => 'result', cleanup)).resolves.toBe('result');
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('preserves the original failure when cleanup succeeds', async () => {
    const failure = new Error('operation failed');
    const result = runWithCleanup(async () => { throw failure; }, async () => undefined);
    await expect(result).rejects.toBe(failure);
  });

  it('retains both failures when operation and cleanup fail', async () => {
    const operationFailure = new Error('operation failed');
    const cleanupFailure = new Error('cleanup failed');
    const failure = await runWithCleanup(
      async () => { throw operationFailure; },
      async () => { throw cleanupFailure; },
    ).catch(error => error) as AggregateError;

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual([operationFailure, cleanupFailure]);
  });

  it('runs every independent cleanup task before reporting failures', async () => {
    const first = vi.fn().mockRejectedValue(new Error('first failed'));
    const second = vi.fn().mockResolvedValue(undefined);
    const third = vi.fn().mockRejectedValue(new Error('third failed'));

    const failure = await runCleanupTasks([first, second, third]).catch(error => error);

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(third).toHaveBeenCalledOnce();
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
  });
});

describe('runWithStartupRollback', () => {
  it('does not close a successfully started long-lived resource', async () => {
    const rollback = vi.fn();

    await expect(runWithStartupRollback(async () => 'listening', rollback))
      .resolves.toBe('listening');
    expect(rollback).not.toHaveBeenCalled();
  });

  it('closes a partially initialized resource after startup fails', async () => {
    const startupFailure = new Error('port already in use');
    const rollback = vi.fn().mockResolvedValue(undefined);

    await expect(runWithStartupRollback(
      async () => { throw startupFailure; },
      rollback,
    )).rejects.toBe(startupFailure);
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('retains both startup and rollback failures', async () => {
    const startupFailure = new Error('port already in use');
    const rollbackFailure = new Error('database pool did not close');
    const failure = await runWithStartupRollback(
      async () => { throw startupFailure; },
      async () => { throw rollbackFailure; },
    ).catch(error => error) as AggregateError;

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual([startupFailure, rollbackFailure]);
  });
});
