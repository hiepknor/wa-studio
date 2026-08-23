import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseParentProcessId,
  startParentProcessWatchdog,
} from '../../src/core/process/parent-process-watchdog';

describe('parent process watchdog', () => {
  afterEach(() => vi.useRealTimers());

  it('accepts an absent or positive parent process identifier', () => {
    expect(parseParentProcessId(undefined)).toBeUndefined();
    expect(parseParentProcessId('42')).toBe(42);
  });

  it.each(['', '0', '-1', '1.5', 'parent'])('rejects invalid parent PID %j', value => {
    expect(() => parseParentProcessId(value)).toThrow(
      'RUNTIME_PARENT_PID must be a positive process identifier',
    );
  });

  it('terminates once when the desktop parent disappears', () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const log = vi.fn();
    const isProcessAlive = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);

    const stop = startParentProcessWatchdog({
      environment: { RUNTIME_PARENT_PID: '42' },
      intervalMs: 1_000,
      isProcessAlive,
      terminate,
      log,
    });
    vi.advanceTimersByTime(3_000);

    expect(isProcessAlive).toHaveBeenCalledTimes(2);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      '[runtime-watchdog] Desktop parent 42 exited; stopping Runtime.',
    );
    stop();
  });

  it('does nothing when no desktop parent was provisioned', () => {
    vi.useFakeTimers();
    const terminate = vi.fn();

    startParentProcessWatchdog({ environment: {}, terminate });
    vi.advanceTimersByTime(5_000);

    expect(terminate).not.toHaveBeenCalled();
  });
});
